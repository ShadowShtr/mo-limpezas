// ============================================================================
// 101b sobre a forma VIVA — não muda absolutamente nada
// ============================================================================
//
// 🔴 A pergunta que este ficheiro faz, e que a anterior não fazia.
//
//    A prova canónica (`canonical-path-101b.pg.test.ts`) mostra que a 101b
//    CONSTRÓI a identidade a partir do estado antigo. Esta mostra o oposto:
//    sobre um catálogo que já está no alvo, a 101b não executa nada.
//
//    E «nada» aqui não é «o estado final é o mesmo». Duas versões anteriores
//    desta migration deixavam o estado final igual e mesmo assim executavam:
//
//      · a primeira largava e recriava 70 políticas em 39 tabelas;
//      · a segunda corrigiu isso, mas continuava a correr `ALTER TABLE`,
//        `CREATE INDEX`, três `CREATE OR REPLACE FUNCTION`, `COMMENT` e
//        `REVOKE`/`GRANT` incondicionalmente.
//
//    Um `CREATE OR REPLACE FUNCTION` sobre uma função já correcta muda-lhe o
//    OID e invalida planos. Um `REVOKE` altera ACL. Nada disso aparece numa
//    comparação de «estado final».
//
//    Por isso mede-se o que mudou, e não o que ficou: OIDs, definições, ACLs,
//    comentários, o conjunto de restrições, o de índices, e as linhas.
//
// ----------------------------------------------------------------------------
// E a ACL, que era uma mudança REAL escondida
// ----------------------------------------------------------------------------
//
// Produção dá hoje `PUBLIC EXECUTE` a `get_my_company_id` e `get_my_role`. A
// versão anterior da 101b revogava-o — endurecimento de segurança novo, a
// viajar à boleia de uma migration de proveniência. `FUNCTION_ACL_CHANGED = 0`
// é a asserção que impede isso de voltar sem ninguém reparar.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";
import { MIGRATIONS_CRM, migrationCrm } from "./helpers/crm-pg-harness";

const CONTAINER = `live-noop-101b-${process.pid}`;
const LENTO = { timeout: 120_000 };

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const GESTORA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLAB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Sem conta no Auth — o caso que o backfill guardado NÃO pode tocar. */
const SEM_CONTA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const M_101B = "supabase/migrations/101b_identity_reconciliation.sql";

let container: PostgresContainer;
let pool: pg.Pool;

const lerSql = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Tudo o que se quer ver inalterado, num retrato só.
 *
 * Inclui OIDs de propósito: é o que distingue «está igual» de «não foi
 * tocado». Uma política recriada com o mesmo texto tem OID novo.
 */
async function retrato() {
  const q = async (sql: string) => (await pool.query(sql)).rows;

  return {
    perfis: await q(`
      SELECT id, auth_user_id, status, must_change_password
        FROM public.profiles ORDER BY id`),
    politicas: await q(`
      SELECT pol.oid::text AS oid, c.relname AS tabela, pol.polname AS nome,
             pg_get_expr(pol.polqual, pol.polrelid)      AS qual,
             pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
       ORDER BY c.relname, pol.polname`),
    funcoes: await q(`
      SELECT p.oid::text AS oid, p.proname AS nome,
             pg_get_functiondef(p.oid)       AS definicao,
             COALESCE(p.proacl::text, '-')   AS acl,
             COALESCE(p.proconfig::text, '-') AS config,
             COALESCE(obj_description(p.oid, 'pg_proc'), '-') AS comentario
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('get_my_profile_id', 'get_my_company_id', 'get_my_role')
       ORDER BY p.proname`),
    restricoes: await q(`
      SELECT conname AS nome, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass
       ORDER BY conname`),
    indices: await q(`
      SELECT indexname AS nome, indexdef AS def
        FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'profiles'
       ORDER BY indexname`),
    colunas: await q(`
      SELECT column_name, data_type, is_nullable, COALESCE(column_default, '-') AS def
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles'
       ORDER BY column_name`),
  };
}

/**
 * A forma VIVA: o baseline, mais a 101b aplicada uma vez.
 *
 * 🔴 É assim que se reproduz produção sem fabricar o drift à mão. A migration
 *    constrói-o, e a partir daí o palco está onde a base real está — o que
 *    torna a segunda corrida exactamente a que produção veria.
 */
async function formaViva(): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE;");
  await pool.query(baselineCompleto());
  await pool.query("ALTER ROLE service_role BYPASSRLS;");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS clients_id_company_unique ON public.clients (id, company_id);
    ALTER TABLE public.data_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
    CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS TRIGGER AS $upd$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $upd$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION public.fn_capture_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $h$
      BEGIN RETURN COALESCE(NEW, OLD); END; $h$;
  `);
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  for (const m of MIGRATIONS_CRM) await pool.query(migrationCrm(m));

  await pool.query("INSERT INTO public.companies (id,name,slug) VALUES ($1,'A','a')", [EMPRESA]);
  await pool.query(
    "INSERT INTO auth.users (id,email) VALUES ($1,'g@a.pt'),($2,'c@a.pt')", [GESTORA, COLAB],
  );
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status) VALUES
      ($1,$2,'Gestora','gestor','ativo'), ($3,$2,'Colaboradora','colaborador','ativo')`,
    [GESTORA, EMPRESA, COLAB],
  );

  // Primeira corrida: constrói. É o que produção já tem hoje.
  await pool.query(lerSql(M_101B));

  // Um perfil sem conta, que só é possível depois de a FK cair — reproduz os
  // 17 que produção tem, e é quem o backfill não pode tocar.
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status)
     VALUES ($1,$2,'Sem Conta','colaborador','ativo')`,
    [SEM_CONTA, EMPRESA],
  );

  // 🔴 E a ACL que produção tem mesmo: `PUBLIC EXECUTE` nestas duas. Sem isto,
  //    o palco não conseguiria apanhar o REVOKE que a versão anterior fazia.
  await pool.query(`
    GRANT EXECUTE ON FUNCTION public.get_my_company_id() TO PUBLIC;
    GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC;
  `);
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER, database: "livenoop", memory: "512m",
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
  await formaViva();
}, 240_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

// ---------------------------------------------------------------------------
describe("o palco reproduz a forma viva", () => {
  it("tem a coluna, a função, os índices — e PUBLIC EXECUTE nas duas", LENTO, async () => {
    const antes = await retrato();

    expect(antes.colunas.map((c) => c.column_name)).toContain("auth_user_id");
    expect(antes.funcoes.map((f) => f.nome)).toContain("get_my_profile_id");
    expect(antes.restricoes.map((r) => r.nome)).not.toContain("profiles_id_fkey");

    // O detalhe que a versão anterior desta migration alterava em silêncio.
    const company = antes.funcoes.find((f) => f.nome === "get_my_company_id");
    expect(company?.acl).toContain("=X/");
  });
});

// ---------------------------------------------------------------------------
describe("🔴 segunda corrida sobre a forma viva — TRUE NO-OP", () => {
  it("não muda uma única coisa das dez que se medem", LENTO, async () => {
    const antes = await retrato();

    // Esta é a corrida que produção veria.
    await pool.query(lerSql(M_101B));

    const depois = await retrato();

    // PROFILE_ROWS_CHANGED + AUTH_USER_ID_VALUES_CHANGED
    expect(depois.perfis).toEqual(antes.perfis);

    // POLICY_OIDS_CHANGED + POLICY_EXPRESSIONS_CHANGED
    expect(depois.politicas).toEqual(antes.politicas);

    // FUNCTION_OIDS_CHANGED + FUNCTION_DEFINITIONS_CHANGED
    //   + FUNCTION_ACL_CHANGED + FUNCTION_COMMENTS_CHANGED
    expect(depois.funcoes).toEqual(antes.funcoes);

    // CONSTRAINT_SET_CHANGED
    expect(depois.restricoes).toEqual(antes.restricoes);

    // INDEX_SET_CHANGED
    expect(depois.indices).toEqual(antes.indices);

    expect(depois.colunas).toEqual(antes.colunas);
  });

  it("🔴 e a ACL das duas funções com PUBLIC fica exactamente como estava", LENTO, async () => {
    const antes = await retrato();
    await pool.query(lerSql(M_101B));
    const depois = await retrato();

    for (const nome of ["get_my_company_id", "get_my_role"]) {
      const a = antes.funcoes.find((f) => f.nome === nome);
      const d = depois.funcoes.find((f) => f.nome === nome);
      // A versão anterior fazia `REVOKE ALL ... FROM PUBLIC` aqui. Isso não é
      // reproduzir o estado vivo — é mudá-lo, e mudá-lo às escondidas.
      expect(d?.acl, `${nome}: a ACL não pode mudar`).toBe(a?.acl);
      expect(d?.oid, `${nome}: a função não pode ser recriada`).toBe(a?.oid);
    }
  });

  it("o backfill não toca em ninguém — nem em quem não tem conta", LENTO, async () => {
    const antes = await pool.query(
      "SELECT id, auth_user_id FROM public.profiles ORDER BY id",
    );
    await pool.query(lerSql(M_101B));
    const depois = await pool.query(
      "SELECT id, auth_user_id FROM public.profiles ORDER BY id",
    );

    expect(depois.rows).toEqual(antes.rows);
    // E quem não tem conta continua sem ligação inventada.
    const semConta = depois.rows.find((r) => r.id === SEM_CONTA);
    expect(semConta?.auth_user_id).toBeNull();
  });

  it("correr uma terceira vez continua a não mudar nada", LENTO, async () => {
    // Idempotência a sério não é «a segunda corrida é inofensiva»: é que
    // qualquer corrida a seguir também é.
    await pool.query(lerSql(M_101B));
    const antes = await retrato();
    await pool.query(lerSql(M_101B));
    expect(await retrato()).toEqual(antes);
  });
});

// ---------------------------------------------------------------------------
describe("o que a 101b deixou de fazer", () => {
  it("🔴 não revoga PUBLIC de get_my_company_id nem de get_my_role", LENTO, async () => {
    // Guarda de texto, para a intenção não voltar por distração. O REVOKE de
    // `get_my_profile_id` é legítimo e só corre quando a função é CRIADA —
    // reproduz a ACL que produção tem.
    //
    // 🔴 Sobre o SQL EXECUTÁVEL, não sobre o ficheiro inteiro: o comentário
    //    que explica a remoção do REVOKE menciona-o, e uma guarda que lesse os
    //    comentários ficaria vermelha por causa da própria explicação. Foi o
    //    que aconteceu à primeira.
    const executavel = lerSql(M_101B)
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

    expect(executavel).not.toMatch(/REVOKE[\s\S]{0,120}get_my_company_id/i);
    expect(executavel).not.toMatch(/REVOKE[\s\S]{0,120}get_my_role/i);
    // E o de `get_my_profile_id` continua lá, onde deve estar.
    expect(executavel).toMatch(/REVOKE[\s\S]{0,80}get_my_profile_id/i);
  });
});
