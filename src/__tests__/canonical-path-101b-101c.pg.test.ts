// ============================================================================
// PISTA B — a cadeia CANÓNICA chega lá sozinha
// ============================================================================
//
// 🔴 O defeito de prova que este ficheiro fecha.
//
//    A primeira versão da prova da 101c montava o palco assim:
//
//        baselineCompleto()
//      + pre-101c-authorization-helpers.sql      ← FABRICA o drift
//      + a migration nova
//
//    E essa fixture diz de si própria que copia o CATÁLOGO VIVO: cria à mão a
//    coluna `auth_user_id`, a FK, o índice e os quatro helpers.
//
//    A prova respondia, portanto, a «a migration funciona sobre o drift que já
//    existe em produção?» — e a resposta era sim. Mas deixava sem resposta a
//    pergunta que decide se o repositório é coerente: «as migrations NOVAS
//    constroem as precondições, ou foi a fixture que as pôs lá?»
//
//    Uma prova que fabrica o preestado de que depende valida-se a si própria.
//
// Aqui não há fixture de drift. O palco é o que o repositório sabe construir,
// e as precondições têm de vir das migrations:
//
//        baseline canónico (forma versionada de produção, PRÉ-drift)
//      + 101 + 101a
//      + 101b   ← tem de CRIAR a identidade
//      + 101c   ← tem de fechar a autorização por estado
//
// ----------------------------------------------------------------------------
// Sobre não replicar 001→101a
// ----------------------------------------------------------------------------
//
// O replay completo continua bloqueado por dívida documentada
// (`docs/LEDGER-RECONCILIATION-PENDING.md`): objectos do Supabase que as
// migrations não criam, ficheiros datados que ordenam depois da `104`, e
// políticas em produção sem migration nenhuma. Usa-se o baseline canónico
// validado, como as outras suites.
//
// 🔴 O que NÃO se faz é o que a pista A fazia: inserir à mão os efeitos que a
//    101b deve criar. O baseline é anterior ao drift — não tem `auth_user_id`,
//    não tem `get_my_profile_id` — e é isso que dá valor a este ficheiro.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";
import { MIGRATIONS_CRM, migrationCrm } from "./helpers/crm-pg-harness";

const CONTAINER = `canonical-path-${process.pid}`;
const LENTO = { timeout: 120_000 };

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const GESTORA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLAB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Um perfil SEM conta no Auth — existe em produção (29 ligados de 46). */
const SEM_CONTA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const M_101B = "supabase/migrations/101b_identity_reconciliation.sql";
const M_101C = "supabase/migrations/101c_status_participa_da_autorizacao.sql";

let container: PostgresContainer;
let pool: pg.Pool;

const lerSql = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

async function comoUtilizador<T>(authUserId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  try {
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authUserId]);
    await c.query("SET ROLE authenticated");
    return await fn(c);
  } finally {
    await c.end().catch(() => { /* já fechada */ });
  }
}

const servicosVisiveis = (authUserId: string) =>
  comoUtilizador(authUserId, async (c) => {
    const { rows } = await c.query("SELECT count(*)::int n FROM public.services");
    return rows[0].n as number;
  });

/**
 * Um perfil SEM conta no Auth — só possível DEPOIS da 101b.
 *
 * 🔴 Isto é um achado, não um detalhe do ensaio.
 *
 *    O estado canónico ainda tem a FK `profiles_id_fkey` (`profiles.id` →
 *    `auth.users.id`): um perfil sem conta é literalmente impossível de
 *    inserir. Em produção essa FK JÁ NÃO EXISTE — foi o EXPAND que a largou, e
 *    é por isso que lá há 17 perfis sem conta ligada.
 *
 *    Tentar semeá-lo antes da 101b rebenta, e é assim que este ficheiro prova
 *    que a 101b faz mesmo alguma coisa: o que era impossível passa a ser
 *    possível por causa dela.
 */
async function semearSemConta(): Promise<void> {
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status)
     VALUES ($1,$2,'Sem Conta','colaborador','ativo')`,
    [SEM_CONTA, EMPRESA],
  );
}

/** O palco canónico: o que o repositório sabe construir, e nada mais. */
async function baseCanonica(): Promise<void> {
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
  await semear();
}

async function semear(): Promise<void> {
  await pool.query("INSERT INTO public.companies (id,name,slug) VALUES ($1,'A','a'),($2,'B','b')", [EMPRESA, OUTRA]);
  await pool.query(
    "INSERT INTO auth.users (id,email) VALUES ($1,'g@a.pt'),($2,'c@a.pt')", [GESTORA, COLAB],
  );
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status) VALUES
      ($1,$2,'Gestora','gestor','ativo'),
      ($3,$2,'Colaboradora','colaborador','ativo')`,
    [GESTORA, EMPRESA, COLAB],
  );
  await pool.query(
    `INSERT INTO public.clients (id,company_id,name)
     VALUES ('c1111111-1111-4111-8111-111111111111',$1,'Cliente A')`, [EMPRESA],
  );
  await pool.query(
    `INSERT INTO public.locations (id,company_id,client_id,name,address)
     VALUES ('10cac111-1111-4111-8111-111111111111',$1,'c1111111-1111-4111-8111-111111111111','Sede','Rua')`,
    [EMPRESA],
  );
  await pool.query(
    `INSERT INTO public.services (id,company_id,location_id,reference_number,scheduled_start,scheduled_end,status)
     VALUES ('5e111111-1111-4111-8111-111111111111',$1,'10cac111-1111-4111-8111-111111111111',
             'S-1', now(), now() + interval '2 hours','agendado')`,
    [EMPRESA],
  );
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER, database: "canonpath", memory: "512m",
  });
  pool = new pg.Pool({ ...container.connection, max: 6 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

// ---------------------------------------------------------------------------
describe("o preestado NÃO existe antes da 101b", () => {
  it("🔴 o baseline canónico não tem identidade separada nenhuma", LENTO, async () => {
    await baseCanonica();

    const coluna = await pool.query(`
      SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profiles' AND column_name='auth_user_id'
    `);
    const funcao = await pool.query(`
      SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
      WHERE ns.nspname='public' AND p.proname='get_my_profile_id'
    `);

    // É isto que a fixture da pista A fabricava. Aqui não existe — e é por
    // isso que o que vier a seguir tem de ter sido construído pelas migrations.
    expect(coluna.rows[0].n).toBe(0);
    expect(funcao.rows[0].n).toBe(0);
  });

  it("e a 101c recusa-se a correr sozinha, em vez de silenciosamente não fazer nada", LENTO, async () => {
    await baseCanonica();
    await expect(pool.query(lerSql(M_101C))).rejects.toThrow(/101c|get_my_profile_id/i);
  });
});

// ---------------------------------------------------------------------------
describe("101b — constrói a identidade a partir do canónico", () => {
  it("cria a coluna, a ligação, os índices e os helpers", LENTO, async () => {
    await baseCanonica();
    await pool.query(lerSql(M_101B));

    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema='public' AND table_name='profiles' AND column_name='auth_user_id') AS coluna,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
          WHERE ns.nspname='public' AND p.proname='get_my_profile_id') AS funcao,
        (SELECT count(*)::int FROM pg_indexes
          WHERE schemaname='public' AND indexname='uq_profiles_auth_user_id') AS indice,
        (SELECT count(*)::int FROM pg_constraint
          WHERE conname='profiles_auth_user_id_fkey') AS fk
    `);
    expect(rows[0]).toEqual({ coluna: 1, funcao: 1, indice: 1, fk: 1 });
  });

  it("🔴 antes da 101b, um perfil sem conta é impossível", LENTO, async () => {
    await baseCanonica();
    // A FK `profiles_id_fkey` ainda está de pé no estado canónico.
    await expect(semearSemConta()).rejects.toThrow(/profiles_id_fkey/);
  });

  it("🔴 o backfill é GUARDADO — não inventa ligações para quem não tem conta", LENTO, async () => {
    await baseCanonica();
    await pool.query(lerSql(M_101B));
    // Só agora é possível: a 101b largou a FK que o exigia.
    await semearSemConta();
    await pool.query(lerSql(M_101B));

    const { rows } = await pool.query(
      "SELECT id, auth_user_id FROM public.profiles ORDER BY full_name",
    );
    const porId = new Map(rows.map((r) => [r.id, r.auth_user_id]));

    // Quem tem conta no Auth ficou ligado...
    expect(porId.get(GESTORA)).toBe(GESTORA);
    expect(porId.get(COLAB)).toBe(COLAB);
    // ...e quem não tem ficou a NULL. Um backfill cego poria o `id` aqui e
    // rebentaria contra a FK — ou, pior, inventaria uma ligação que ninguém
    // criou. Em produção são 17 perfis nesta situação.
    expect(porId.get(SEM_CONTA)).toBeNull();
  });

  it("é idempotente — correr outra vez não muda nada", LENTO, async () => {
    await baseCanonica();
    await pool.query(lerSql(M_101B));
    const antes = await pool.query(
      "SELECT id, auth_user_id FROM public.profiles ORDER BY id",
    );

    // Sobre produção, a 101b É esta segunda corrida: tudo já existe.
    await pool.query(lerSql(M_101B));

    const depois = await pool.query(
      "SELECT id, auth_user_id FROM public.profiles ORDER BY id",
    );
    expect(depois.rows).toEqual(antes.rows);
  });

  it("as políticas passam a resolver pelo helper, e nenhuma fica por `auth.uid()`", LENTO, async () => {
    await baseCanonica();
    await pool.query(lerSql(M_101B));

    const { rows } = await pool.query(`
      SELECT count(*)::int n FROM pg_policies
      WHERE schemaname='public'
        AND (COALESCE(qual,'') || COALESCE(with_check,'')) ~ 'auth\\.uid\\(\\)'
    `);
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("101c — sobre o que a 101b construiu, não sobre uma fixture", () => {
  async function cadeiaCompleta(): Promise<void> {
    await baseCanonica();
    await pool.query(lerSql(M_101B));
    await pool.query(lerSql(M_101C));
  }

  it("ativo → acesso", LENTO, async () => {
    await cadeiaCompleta();
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });

  it("🔴 inativo → o mesmo token deixa de ler", LENTO, async () => {
    await cadeiaCompleta();
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);

    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);
  });

  it("suspenso → nega", LENTO, async () => {
    await cadeiaCompleta();
    await pool.query("UPDATE public.profiles SET status='suspenso' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);
  });

  it("desconhecido e nulo → negam", LENTO, async () => {
    await cadeiaCompleta();
    await pool.query("ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_status_check");
    for (const estado of [null, "", "arquivado", "ATIVO"]) {
      await pool.query("UPDATE public.profiles SET status=$2 WHERE id=$1", [GESTORA, estado]);
      expect(await servicosVisiveis(GESTORA), `status=${JSON.stringify(estado)}`).toBe(0);
    }
  });

  it("volta a ativo → devolve o acesso", LENTO, async () => {
    await cadeiaCompleta();
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);
    await pool.query("UPDATE public.profiles SET status='ativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });

  it("a ordem inversa não passa — 101c antes de 101b é recusada", LENTO, async () => {
    await baseCanonica();
    await expect(pool.query(lerSql(M_101C))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("o `102` fica livre para o CRM", () => {
  it("nenhuma migration desta frente ocupa 102, 103 ou 104", LENTO, async () => {
    // O cabeçalho da 101a reserva o `102` para as visitas comerciais, e a PR
    // #179 traz 102/103/104. Esta frente usa sufixos entre `101a` e `102`.
    const { readdirSync } = await import("node:fs");
    const nomes = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"));

    for (const reservado of ["102_", "103_", "104_"]) {
      expect(
        nomes.filter((n) => n.startsWith(reservado)),
        `${reservado} está reservado ao CRM`,
      ).toEqual([]);
    }

    // E os sufixos desta frente ordenam onde têm de ordenar.
    expect(["101a", "101b", "101c", "102"].slice().sort()).toEqual(["101a", "101b", "101c", "102"]);
  });
});
