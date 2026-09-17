// ============================================================================
// 101c — a revogação chega à base: PISTA A, o ensaio sobre a forma VIVA
// ============================================================================
//
// 🔴 Porque é que os ensaios anteriores não bastavam.
//
// 🔴 O QUE ESTA PISTA RESPONDE, E O QUE NÃO RESPONDE.
//
//    Esta monta a forma VIVA de produção — incluindo o drift de identidade —
//    e prova que a 101c funciona sobre ela. É a pergunta operacional: «ao
//    aplicar isto à base real, o que acontece?»
//
//    NÃO responde à outra: «a cadeia canónica do repositório chega ao
//    preestado de que esta migration depende?». Essa é a PISTA B,
//    `canonical-path-101b-101c.pg.test.ts`, e existe porque a fixture usada
//    aqui FABRICA o drift em vez de o construir a partir das migrations.
//
//    Duas perguntas, duas pistas. Uma prova só, montada sobre a fixture,
//    respondia à primeira e dava a impressão de ter respondido às duas.
//
//    `collaborator-access-revocation.test.ts` prova que as Server Actions
//    recusam quem levou saída. Prova-o com mocks do Next.js — e o que estava
//    em causa é precisamente o caminho que NÃO passa pelo Next.js: um token
//    ainda válido a falar directamente com o PostgREST, que avalia RLS com
//    `auth.uid()` e nada mais.
//
//    Uma prova em mocks não podia responder a isso. Estes ensaios trocam a
//    identidade da ligação como o PostgREST faz — `request.jwt.claim.sub` e
//    `SET ROLE authenticated` — e medem o que a BASE deixa passar.
//
// O ensaio decisivo é o B: a MESMA ligação, com o MESMO `sub` (o token não
// mudou, não foi reemitido, não expirou), deixa de conseguir ler assim que o
// perfil passa a inativo.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";

const CONTAINER = `status-authz-a-${process.pid}`;
const LENTO = { timeout: 120_000 };

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const GESTORA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLAB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COLAB_OUTRA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let container: PostgresContainer;
let pool: pg.Pool;

const lerSql = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const PRE_101C = "src/__tests__/fixtures/pre-101c-authorization-helpers.sql";
const MIGRATION_101C = "supabase/migrations/101c_status_participa_da_autorizacao.sql";
const ROLLBACK_101C = "supabase/migrations/rollback/101c_status_participa_da_autorizacao.down.sql";

/**
 * Uma ligação com a identidade de um utilizador autenticado.
 *
 * 🔴 É assim que o PostgREST fala com a base, e é isso que torna estes ensaios
 *    diferentes dos de mocks: `request.jwt.claim.sub` é o que `auth.uid()` lê.
 *    Um token já emitido é exactamente isto — um `sub` fixo numa ligação.
 */
async function comoUtilizador<T>(
  authUserId: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
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

/** Como as Server Actions falam: `service_role`, que tem BYPASSRLS. */
async function comoServiceRole<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  try {
    await c.query("SET ROLE service_role");
    return await fn(c);
  } finally {
    await c.end().catch(() => { /* já fechada */ });
  }
}

/** Quantos serviços esta identidade consegue LER. A medida de acesso. */
async function servicosVisiveis(authUserId: string): Promise<number> {
  return comoUtilizador(authUserId, async (c) => {
    const { rows } = await c.query("SELECT count(*)::int n FROM public.services");
    return rows[0].n as number;
  });
}

async function montarPalco(aplicar101c: boolean): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE;");
  await pool.query(baselineCompleto());
  await pool.query("ALTER ROLE service_role BYPASSRLS;");
  await pool.query(lerSql(PRE_101C));
  if (aplicar101c) await pool.query(lerSql(MIGRATION_101C));
  await semear();
}

async function semear(): Promise<void> {
  await pool.query(
    "INSERT INTO public.companies (id, name, slug) VALUES ($1,'A','a'), ($2,'B','b')",
    [EMPRESA, OUTRA],
  );
  await pool.query(
    `INSERT INTO auth.users (id, email) VALUES
      ($1,'gestora@a.pt'), ($2,'colab@a.pt'), ($3,'colab@b.pt')`,
    [GESTORA, COLAB, COLAB_OUTRA],
  );
  // `auth_user_id = id` reproduz produção, onde as 29 contas ligadas têm os
  // dois iguais (`auth_user_id != id` = 0, lido read-only).
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status, auth_user_id) VALUES
      ($1,$2,'Gestora','gestor','ativo',$1),
      ($3,$2,'Colaboradora','colaborador','ativo',$3),
      ($4,$5,'Colab Outra','colaborador','ativo',$4)`,
    [GESTORA, EMPRESA, COLAB, COLAB_OUTRA, OUTRA],
  );
  await pool.query(
    `INSERT INTO public.clients (id, company_id, name)
     VALUES ('c1111111-1111-4111-8111-111111111111',$1,'Cliente A'),
            ('c2222222-2222-4222-8222-222222222222',$2,'Cliente B')`,
    [EMPRESA, OUTRA],
  );
  await pool.query(
    `INSERT INTO public.locations (id, company_id, client_id, name, address)
     VALUES ('10cac111-1111-4111-8111-111111111111',$1,'c1111111-1111-4111-8111-111111111111','Sede A','Rua A'),
            ('10cab222-2222-4222-8222-222222222222',$2,'c2222222-2222-4222-8222-222222222222','Sede B','Rua B')`,
    [EMPRESA, OUTRA],
  );
  await pool.query(
    `INSERT INTO public.teams (id, company_id, name, active)
     VALUES ('7ea11111-1111-4111-8111-111111111111',$1,'Equipa A',true)`,
    [EMPRESA],
  );
  await pool.query(
    `INSERT INTO public.team_members (team_id, collaborator_id)
     VALUES ('7ea11111-1111-4111-8111-111111111111',$1)`,
    [COLAB],
  );
  await pool.query(
    `INSERT INTO public.services
       (id, company_id, location_id, team_id, reference_number, scheduled_start, scheduled_end, status)
     VALUES ('5e111111-1111-4111-8111-111111111111',$1,'10cac111-1111-4111-8111-111111111111',
             '7ea11111-1111-4111-8111-111111111111','S-A-001', now(), now() + interval '2 hours','agendado'),
            ('5e222222-2222-4222-8222-222222222222',$2,'10cab222-2222-4222-8222-222222222222',
             NULL,'S-B-001', now(), now() + interval '2 hours','agendado')`,
    [EMPRESA, OUTRA],
  );
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER, database: "statusauthz", memory: "512m",
  });
  pool = new pg.Pool({ ...container.connection, max: 6 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

// ---------------------------------------------------------------------------
describe("ANTES da 101c — o buraco existe mesmo", () => {
  beforeEach(async () => { await montarPalco(false); }, 120_000);

  it("🔴 um perfil inativo continua a ler pela base, com o mesmo token", LENTO, async () => {
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);

    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);

    // Nada mudou no token. E a base continua a deixar entrar.
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });

  it("os helpers resolvem identidade para quem já saiu", LENTO, async () => {
    await pool.query("UPDATE public.profiles SET status='suspenso' WHERE id=$1", [GESTORA]);
    const resolvido = await comoUtilizador(GESTORA, async (c) => {
      const { rows } = await c.query(
        "SELECT public.get_my_profile_id() AS pid, public.get_my_company_id() AS cid, public.get_my_role() AS r",
      );
      return rows[0];
    });
    expect(resolvido.pid).toBe(GESTORA);
    expect(resolvido.cid).toBe(EMPRESA);
    expect(resolvido.r).toBe("gestor");
  });
});

// ---------------------------------------------------------------------------
describe("DEPOIS da 101c", () => {
  beforeEach(async () => { await montarPalco(true); }, 120_000);

  it("A. perfil ativo — o acesso legítimo continua exactamente igual", LENTO, async () => {
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);

    const resolvido = await comoUtilizador(GESTORA, async (c) => {
      const { rows } = await c.query(
        "SELECT public.get_my_profile_id() AS pid, public.get_my_company_id() AS cid, public.get_my_role() AS r",
      );
      return rows[0];
    });
    expect(resolvido.pid).toBe(GESTORA);
    expect(resolvido.cid).toBe(EMPRESA);
    expect(resolvido.r).toBe("gestor");
  });

  it("B. 🔴 mesmo token, mesmo `sub` — inativo deixa de ler", LENTO, async () => {
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);

    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);

    // O token não foi reemitido nem expirou. A base é que deixou de aceitar.
    expect(await servicosVisiveis(GESTORA)).toBe(0);
  });

  it("C. suspenso — nega", LENTO, async () => {
    await pool.query("UPDATE public.profiles SET status='suspenso' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);
  });

  it("D. null, vazio e desconhecido — negam todos", LENTO, async () => {
    // O CHECK de produção não admite estes valores, mas a regra não pode
    // depender disso: um CHECK alterado noutra frente não pode reabrir acesso.
    await pool.query("ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_status_check");

    for (const estado of [null, "", "  ", "arquivado", "ferias", "ATIVO"]) {
      await pool.query("UPDATE public.profiles SET status=$2 WHERE id=$1", [GESTORA, estado]);
      expect(await servicosVisiveis(GESTORA), `status=${JSON.stringify(estado)}`).toBe(0);
    }

    // E o contrapeso: 'ativo' exacto volta a deixar entrar.
    await pool.query("UPDATE public.profiles SET status='ativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });

  it("E. outro tenant continua isolado", LENTO, async () => {
    const daOutra = await comoUtilizador(COLAB_OUTRA, async (c) => {
      const { rows } = await c.query(
        "SELECT count(*)::int n FROM public.services WHERE company_id = $1", [EMPRESA],
      );
      return rows[0].n as number;
    });
    expect(daOutra).toBe(0);
  });

  it("F. service_role não parte — é por lá que a administração trabalha", LENTO, async () => {
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [COLAB]);

    const visto = await comoServiceRole(async (c) => {
      const { rows } = await c.query(
        "SELECT count(*)::int n FROM public.profiles WHERE company_id=$1", [EMPRESA],
      );
      return rows[0].n as number;
    });
    // 🔴 Se isto fosse a zero, desativar seria irreversível: o painel deixaria
    //    de conseguir ver — e portanto reactivar — quem desativou.
    expect(visto).toBe(2);

    const reativou = await comoServiceRole(async (c) => {
      const { rowCount } = await c.query(
        "UPDATE public.profiles SET status='ativo' WHERE id=$1", [COLAB],
      );
      return rowCount;
    });
    expect(reativou).toBe(1);
  });

  it("G. can_access_service deixou de ser um contorno", LENTO, async () => {
    const servico = "5e111111-1111-4111-8111-111111111111";

    const antes = await comoUtilizador(COLAB, async (c) => {
      const { rows } = await c.query("SELECT public.can_access_service($1) AS ok", [servico]);
      return rows[0].ok as boolean;
    });
    expect(antes).toBe(true);

    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [COLAB]);

    const depois = await comoUtilizador(COLAB, async (c) => {
      const { rows } = await c.query("SELECT public.can_access_service($1) AS ok", [servico]);
      return rows[0].ok as boolean;
    });
    expect(depois).toBe(false);
  });

  it("G2. e passou a ter search_path fixado", LENTO, async () => {
    // 🔴 A afirmação é sobre ESTA função, e não sobre o schema todo.
    //
    //    Em produção, `can_access_service` era a única das 24 SECURITY DEFINER
    //    sem `search_path` (medido read-only). No palco há mais, porque o
    //    baseline cria cotos sem ele — afirmar aqui «zero no schema» seria
    //    medir o andaime em vez do que a migration faz.
    const { rows } = await pool.query(`
      SELECT p.prosecdef AS secdef, COALESCE(p.proconfig::text,'') AS config
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname='public' AND p.proname='can_access_service'
    `);
    expect(rows[0].secdef).toBe(true);
    expect(rows[0].config).toContain("search_path");
  });

  it("H. voltar a ativo devolve o acesso — a desativação é reversível", LENTO, async () => {
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);

    await pool.query("UPDATE public.profiles SET status='ativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });

  it("o ALVO pode estar inativo — o que conta é o estado de quem chama", LENTO, async () => {
    // Uma gestora activa tem de continuar a ver e a gerir quem desativou.
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [COLAB]);
    const vistos = await comoUtilizador(GESTORA, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int n FROM public.profiles");
      return rows[0].n as number;
    });
    expect(vistos).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("o rollback repõe o estado anterior — incluindo o buraco", () => {
  it("depois de reverter, um inativo volta a ler", LENTO, async () => {
    await montarPalco(true);
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [GESTORA]);
    expect(await servicosVisiveis(GESTORA)).toBe(0);

    await pool.query(lerSql(ROLLBACK_101C));

    // 🔴 É isto que o rollback custa, e está escrito no próprio ficheiro.
    expect(await servicosVisiveis(GESTORA)).toBeGreaterThan(0);
  });
});
