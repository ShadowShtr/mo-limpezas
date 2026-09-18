// ============================================================================
// 102 — visitas comerciais, sobre a cadeia REAL do master
// ============================================================================
//
// 🔴 O que esta prova existe para responder.
//
//    A 102 foi escrita na PR #179, contra um estado em que só a `101` existia.
//    Desde então o master ganhou a `101a` (ACL das RPC do funil) e a `101b`
//    (canonicalização da identidade, já aplicada em produção).
//
//    A `101b` mudou o que `get_my_company_id()` e `get_my_role()` fazem por
//    dentro: passaram a delegar em `get_my_profile_id()`. A 102 usa as duas nas
//    suas políticas. Reaproveitar a migration antiga sem a medir contra a
//    cadeia nova seria assumir que nada disso lhe toca.
//
//    Por isso o palco aqui é a cadeia como ela está hoje:
//
//        baseline canónico + 101 + 101a + 101b  →  102
//
//    E NÃO inclui a 101c. Provar que a 102 não depende dela é parte do
//    trabalho: o endurecimento por `status` seguiu para outra frente, e o CRM
//    não pode ficar refém disso.
//
// ---------------------------------------------------------------------------
// As duas perguntas que esta suite passou a responder
// ---------------------------------------------------------------------------
//
//   1. PROVENIÊNCIA — se `crm_visits` existir sem a 102 no ledger, a migration
//      recusa-se e não escreve nada. Um objecto existir não prova quem o
//      criou, e adoptá-lo seria passar a alterar restrições e ACL de uma
//      tabela cujo conteúdo esta migration não conhece.
//
//   2. NO_DATA_LOSS — o rollback recusa-se a apagar visitas. A versão anterior
//      destes ensaios criava uma visita e dava VERDE por o rollback a ter
//      apagado: media a destruição e chamava-lhe prova.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";
import { MIGRATIONS_CRM, migrationCrm } from "./helpers/crm-pg-harness";

const CONTAINER = `crm102-${process.pid}`;
const LENTO = { timeout: 120_000 };

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const GESTORA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GESTORA_OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COLAB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENTE_A = "c1111111-1111-4111-8111-111111111111";
const CLIENTE_B = "c2222222-2222-4222-8222-222222222222";

const M_101B = "supabase/migrations/101b_identity_reconciliation.sql";
const M_102 = "supabase/migrations/102_crm_visitas_comerciais.sql";
const ROLLBACK_102 = "supabase/migrations/rollback/102_crm_visitas_comerciais.down.sql";

/**
 * A cadeia que a 102 exige ver no ledger, pelo nome com que o runner a regista.
 *
 * 🔴 Os checksums NÃO estão escritos aqui à mão. São calculados a partir do
 *    ficheiro, do mesmo modo que `checksumForNewMigration` os calcula
 *    (SHA-256 sobre o conteúdo normalizado para LF). É isso que faz deste
 *    ensaio um guarda dos valores pinados dentro da 102: se alguém editar a
 *    101b e não actualizar o hash lá dentro, o ledger encenado aqui deixa de
 *    bater e a 102 recusa-se — vermelho, em vez de uma migration que só
 *    rebentaria em produção.
 */
const CADEIA = [
  "101_crm_leads.sql",
  "101a_crm_rpc_acl_hardening.sql",
  "101b_identity_reconciliation.sql",
] as const;

let container: PostgresContainer;
let pool: pg.Pool;

const lerSql = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** O mesmo cálculo de `checksumForNewMigration`: SHA-256 sobre LF normalizado. */
const checksumLf = (ficheiro: string): string =>
  createHash("sha256")
    .update(lerSql(`supabase/migrations/${ficheiro}`).split("\r\n").join("\n").split("\r").join("\n"))
    .digest("hex");

/**
 * Levanta `public._migrations` e escreve as linhas da cadeia, como o runner
 * canónico faria. `substituir` deixa um ensaio encenar um ledger partido.
 */
async function montarLedger(
  substituir: Readonly<Record<string, string | null>> = {},
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  for (const nome of CADEIA) {
    const valor = nome in substituir ? substituir[nome] : checksumLf(nome);
    if (valor === null) continue; // linha deliberadamente em falta
    await pool.query(
      `INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum`,
      [nome, valor],
    );
  }
}

/** Uma ligação com a identidade de quem faz o pedido, como o PostgREST a faz. */
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

/** A cadeia do master: 101 → 101a → 101b. Sem 101c, de propósito. */
async function cadeiaDoMaster(aplicar102: boolean): Promise<void> {
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
  await pool.query(lerSql(M_101B));
  await semear();
  // O `DROP SCHEMA public CASCADE` acima leva o ledger à frente, por isso ele
  // é reposto aqui — a 102 exige ver a cadeia provada, não apenas o schema.
  await montarLedger();
  if (aplicar102) await pool.query(lerSql(M_102));
}

async function semear(): Promise<void> {
  await pool.query(
    "INSERT INTO public.companies (id,name,slug) VALUES ($1,'A','a'),($2,'B','b')",
    [EMPRESA, OUTRA],
  );
  await pool.query(
    `INSERT INTO auth.users (id,email) VALUES ($1,'g@a.pt'),($2,'g@b.pt'),($3,'c@a.pt')`,
    [GESTORA, GESTORA_OUTRA, COLAB],
  );
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status, auth_user_id) VALUES
      ($1,$2,'Gestora A','gestor','ativo',$1),
      ($3,$4,'Gestora B','gestor','ativo',$3),
      ($5,$2,'Colaboradora','colaborador','ativo',$5)`,
    [GESTORA, EMPRESA, GESTORA_OUTRA, OUTRA, COLAB],
  );
  await pool.query(
    `INSERT INTO public.clients (id,company_id,name)
     VALUES ($1,$2,'Cliente A'), ($3,$4,'Cliente B')`,
    [CLIENTE_A, EMPRESA, CLIENTE_B, OUTRA],
  );
}

/** Cria uma visita por `service_role`, como as Server Actions fazem. */
async function novaVisita(over: Record<string, unknown> = {}): Promise<string> {
  const inicio = new Date();
  const campos: Record<string, unknown> = {
    company_id: EMPRESA,
    client_id: CLIENTE_A,
    scheduled_start: inicio.toISOString(),
    // `scheduled_end` é NOT NULL: uma visita sem fim não é agenda, é intenção.
    scheduled_end: new Date(inicio.getTime() + 60 * 60 * 1000).toISOString(),
    created_by: GESTORA,
    ...over,
  };
  const colunas = Object.keys(campos);
  const marcas = colunas.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO public.crm_visits (${colunas.join(", ")}) VALUES (${marcas}) RETURNING id`,
    Object.values(campos),
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER, database: "crm102", memory: "512m",
  });
  pool = new pg.Pool({ ...container.connection, max: 6 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

// ---------------------------------------------------------------------------
describe("a 102 corre sobre a cadeia actual do master", () => {
  it("aplica sobre 101 + 101a + 101b", LENTO, async () => {
    await cadeiaDoMaster(true);
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBe("crm_visits");
  });

  it("🔴 não depende da 101c — que nem sequer está aplicada aqui", LENTO, async () => {
    await cadeiaDoMaster(true);

    // A 101c muda `get_my_profile_id()` para exigir `status = 'ativo'`. Se a
    // 102 dependesse disso, este palco não a teria feito correr — e não tem.
    const { rows } = await pool.query(`
      SELECT position('status' in pg_get_functiondef(p.oid)) AS tem_status
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_my_profile_id'`);
    expect(rows[0].tem_status).toBe(0);

    // E a tabela funciona na mesma.
    const id = await novaVisita();
    expect(id).toBeTruthy();
  });

  it("as precondições de schema recusam se a 101 não tiver corrido", LENTO, async () => {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await pool.query("DROP SCHEMA IF EXISTS auth CASCADE;");
    await pool.query(baselineCompleto());
    // Ledger a dizer que a cadeia correu, schema a dizer que não. O portão de
    // proveniência passa e são as precondições de objectos que travam — que é
    // exactamente o drift que este projecto já conhece.
    await montarLedger();
    await expect(pool.query(lerSql(M_102))).rejects.toThrow(/PRECONDITION_FAILED|crm_leads/i);
  });
});

// ---------------------------------------------------------------------------
// 🔴 SCHEMA_EFFECT != MIGRATION_PROVENANCE
//
// O que se mede aqui não é «devolveu erro». É que, perante um estado
// desconhecido, a 102 não escreveu NADA — nem uma restrição, nem uma política,
// nem um grant — e deixou intacto o objecto que encontrou.
// ---------------------------------------------------------------------------
describe("proveniência: efeito sem ledger falha fechado", () => {
  /** Estado pós-101b com o ledger da cadeia, e a 102 ainda por correr. */
  async function palcoPre102(): Promise<void> {
    await cadeiaDoMaster(false);
  }

  /** Tudo o que a 102 acrescentaria, para se poder provar que não acrescentou. */
  async function marcasDa102(): Promise<{
    restricoes: number; politicas: number; indices: number; colunas: string[];
  }> {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM pg_constraint
          WHERE conname LIKE 'crm_visits_%') AS restricoes,
        (SELECT count(*)::int FROM pg_policies
          WHERE schemaname='public' AND tablename='crm_visits') AS politicas,
        (SELECT count(*)::int FROM pg_indexes
          WHERE schemaname='public' AND indexname LIKE 'idx_crm_visits%') AS indices,
        -- column_name é do tipo name; sem o cast o driver devolve a
        -- representação textual do array em vez de um array.
        (SELECT coalesce(array_agg(column_name::text ORDER BY column_name), '{}')
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='crm_visits') AS colunas`);
    return {
      restricoes: rows[0].restricoes as number,
      politicas: rows[0].politicas as number,
      indices: rows[0].indices as number,
      colunas: rows[0].colunas as string[],
    };
  }

  it("🔴 EFFECT_WITHOUT_LEDGER: crm_visits existe sem a 102 no ledger — REJEITADO", LENTO, async () => {
    await palcoPre102();

    // Uma `crm_visits` nascida fora da 102. Nada nela veio desta migration.
    await pool.query(`
      CREATE TABLE public.crm_visits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nota_de_quem_a_criou text
      )`);
    const antes = await marcasDa102();

    await expect(pool.query(lerSql(M_102)))
      .rejects.toThrow(/EFFECT_WITHOUT_LEDGER/);

    // 6. o objecto pré-existente permanece inalterado
    const depois = await marcasDa102();
    expect(depois.colunas).toEqual(antes.colunas);
    expect(depois.colunas).toEqual(["id", "nota_de_quem_a_criou"]);

    // 7. zero DDL adicional
    expect(depois.restricoes).toBe(antes.restricoes);
    expect(depois.politicas).toBe(0);
    expect(depois.indices).toBe(0);

    // A 102 não adoptou a tabela: nenhuma das suas restrições nomeadas lá está.
    const { rows: c } = await pool.query(`
      SELECT count(*)::int n FROM pg_constraint
       WHERE conname IN ('crm_visits_um_destinatario','crm_visits_janela_valida',
                         'crm_visits_lead_mesma_empresa','crm_visits_cliente_mesma_empresa')`);
    expect(c[0].n).toBe(0);

    // RLS não foi ligada por arrasto.
    const { rows: r } = await pool.query(`
      SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='crm_visits'`);
    expect(r[0].relrowsecurity).toBe(false);

    // 8. zero linha de ledger 102
    const { rows: l } = await pool.query(
      "SELECT count(*)::int n FROM public._migrations WHERE name='102_crm_visitas_comerciais.sql'");
    expect(l[0].n).toBe(0);
  });

  it("🔴 MISSING_101B_LEDGER: sem a linha da 101b — REJEITADO", LENTO, async () => {
    await palcoPre102();
    await pool.query("DELETE FROM public._migrations WHERE name='101b_identity_reconciliation.sql'");

    await expect(pool.query(lerSql(M_102)))
      .rejects.toThrow(/MISSING_PREREQUISITE_LEDGER/);
    // Nada foi criado: o portão está antes de toda a mutação.
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBeNull();
  });

  it("🔴 WRONG_101B_CHECKSUM: outro conteúdo sob a 102 — REJEITADO", LENTO, async () => {
    await palcoPre102();
    await pool.query(
      "UPDATE public._migrations SET checksum=$1 WHERE name='101b_identity_reconciliation.sql'",
      ["0".repeat(64)],
    );

    await expect(pool.query(lerSql(M_102)))
      .rejects.toThrow(/CHECKSUM_MISMATCH_PREREQUISITE/);
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBeNull();
  });

  it("🔴 um checksum NULL no ledger é tratado como errado, não como aceite", LENTO, async () => {
    await palcoPre102();
    await pool.query(
      "UPDATE public._migrations SET checksum=NULL WHERE name='101_crm_leads.sql'");

    await expect(pool.query(lerSql(M_102)))
      .rejects.toThrow(/CHECKSUM_MISMATCH_PREREQUISITE/);
  });

  it("sem tabela de ledger nenhuma, a 102 não corre", LENTO, async () => {
    await palcoPre102();
    await pool.query("DROP TABLE public._migrations");

    await expect(pool.query(lerSql(M_102))).rejects.toThrow(/LEDGER_AUSENTE/);
  });

  it("a 102 recusa-se a correr duas vezes sobre a mesma linha de ledger", LENTO, async () => {
    await cadeiaDoMaster(true);
    await pool.query(
      "INSERT INTO public._migrations (name, checksum) VALUES ('102_crm_visitas_comerciais.sql','x')");

    await expect(pool.query(lerSql(M_102))).rejects.toThrow(/JA_APLICADA/);
  });

  it("CHAIN_101_101A_101B_102: com a cadeia inteira provada, aplica", LENTO, async () => {
    await palcoPre102();
    await pool.query(lerSql(M_102));
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBe("crm_visits");
  });
});

// ---------------------------------------------------------------------------
describe("integridade com o 101 e com profiles", () => {
  beforeEach(async () => { await cadeiaDoMaster(true); }, 120_000);

  it("uma visita pode nascer sem lead — a agenda não exige funil", LENTO, async () => {
    const id = await novaVisita();
    const { rows } = await pool.query("SELECT lead_id FROM public.crm_visits WHERE id=$1", [id]);
    expect(rows[0].lead_id).toBeNull();
  });

  it("ligada a uma lead, segue-a quando ela desaparece", LENTO, async () => {
    const { rows: l } = await pool.query(
      "INSERT INTO public.crm_leads (company_id, name) VALUES ($1,'Condomínio') RETURNING id",
      [EMPRESA],
    );
    const lead = l[0].id as string;
    // `crm_visits_um_destinatario`: uma visita é a UMA lead ou a UM cliente,
    // nunca às duas. É o que impede uma visita com dois donos.
    await novaVisita({ lead_id: lead, client_id: null });

    await pool.query("DELETE FROM public.crm_leads WHERE id=$1", [lead]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_visits");
    // `ON DELETE CASCADE`: a visita pertence à lead.
    expect(rows[0].n).toBe(0);
  });

  it("🔴 o cliente NÃO é apagado por arrasto de uma visita", LENTO, async () => {
    await novaVisita();
    // `ON DELETE RESTRICT`: um cliente com visitas não desaparece em silêncio.
    await expect(
      pool.query("DELETE FROM public.clients WHERE id=$1", [CLIENTE_A]),
    ).rejects.toThrow();
  });

  it("🔴 um perfil responsável por visitas não pode ser apagado", LENTO, async () => {
    await novaVisita({ assigned_to: COLAB });
    // `ON DELETE NO ACTION` — a autoria não se perde para caber num DELETE.
    await expect(
      pool.query("DELETE FROM public.profiles WHERE id=$1", [COLAB]),
    ).rejects.toThrow();
  });

  it("quem marcou também segura o perfil", LENTO, async () => {
    await novaVisita({ created_by: GESTORA });
    await expect(
      pool.query("DELETE FROM public.profiles WHERE id=$1", [GESTORA]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("isolamento por empresa", () => {
  beforeEach(async () => { await cadeiaDoMaster(true); }, 120_000);

  it("🔴 a FK composta recusa um responsável de outra empresa", LENTO, async () => {
    await expect(
      novaVisita({ assigned_to: GESTORA_OUTRA }),
    ).rejects.toThrow();
  });

  it("recusa um cliente de outra empresa", LENTO, async () => {
    await expect(novaVisita({ client_id: CLIENTE_B })).rejects.toThrow();
  });

  it("recusa uma lead de outra empresa", LENTO, async () => {
    const { rows } = await pool.query(
      "INSERT INTO public.crm_leads (company_id, name) VALUES ($1,'Da B') RETURNING id",
      [OUTRA],
    );
    await expect(novaVisita({ lead_id: rows[0].id, client_id: null })).rejects.toThrow();
  });

  it("🔴 a gestora da outra empresa não vê estas visitas", LENTO, async () => {
    await novaVisita();
    const vistas = await comoUtilizador(GESTORA_OUTRA, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int n FROM public.crm_visits");
      return rows[0].n as number;
    });
    expect(vistas).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("permissões", () => {
  beforeEach(async () => { await cadeiaDoMaster(true); }, 120_000);

  it("a gestora da empresa vê as suas visitas", LENTO, async () => {
    await novaVisita();
    const vistas = await comoUtilizador(GESTORA, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int n FROM public.crm_visits");
      return rows[0].n as number;
    });
    expect(vistas).toBe(1);
  });

  it("🔴 uma colaboradora não vê a agenda comercial", LENTO, async () => {
    await novaVisita();
    const vistas = await comoUtilizador(COLAB, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int n FROM public.crm_visits");
      return rows[0].n as number;
    });
    expect(vistas).toBe(0);
  });

  it("🔴 `authenticated` não escreve directamente — só lê", LENTO, async () => {
    // O modelo endurecido pós-084/085: as escritas passam todas por
    // `service_role`, nas Server Actions. Um cliente com sessão não insere.
    await comoUtilizador(GESTORA, async (c) => {
      await expect(
        c.query(
          `INSERT INTO public.crm_visits (company_id, client_id, scheduled_start, scheduled_end)
           VALUES ($1,$2,now(),now() + interval '1 hour')`,
          [EMPRESA, CLIENTE_A],
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("`anon` não chega à tabela", LENTO, async () => {
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query("SET ROLE anon");
      await expect(
        c.query("SELECT count(*) FROM public.crm_visits"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await c.end();
    }
  });

  it("`service_role` escreve — é por lá que a aplicação trabalha", LENTO, async () => {
    const escreveu = await comoServiceRole(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.crm_visits (company_id, client_id, scheduled_start, scheduled_end, created_by)
         VALUES ($1,$2,now(),now() + interval '1 hour',$3) RETURNING id`,
        [EMPRESA, CLIENTE_A, GESTORA],
      );
      return rows[0].id as string;
    });
    expect(escreveu).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 🔴 NO_DATA_LOSS. A versão anterior deste bloco criava uma visita e dava
//    verde por o rollback a ter apagado. Media a destruição e chamava-lhe
//    prova. A visita é o único registo do que se foi ver ao local — área,
//    horas estimadas, notas — e não se reconstrói a partir de nada.
describe("rollback", () => {
  it("ROLLBACK_EMPTY: tabela vazia — desfaz, e deixa a 101 de pé", LENTO, async () => {
    await cadeiaDoMaster(true);

    await pool.query(lerSql(ROLLBACK_102));

    const { rows } = await pool.query(`
      SELECT to_regclass('public.crm_visits') AS visitas,
             to_regclass('public.crm_leads')  AS leads`);
    expect(rows[0].visitas).toBeNull();
    // 🔴 O funil não pode ir atrás: a 101 está aplicada em produção.
    expect(rows[0].leads).toBe("crm_leads");
  });

  it("🔴 ROLLBACK_WITH_DATA: com uma visita — RECUSADO, e nada se perde", LENTO, async () => {
    await cadeiaDoMaster(true);
    const { rows: l } = await pool.query(
      "INSERT INTO public.crm_leads (company_id, name) VALUES ($1,'Condomínio') RETURNING id",
      [EMPRESA],
    );
    const lead = l[0].id as string;
    const visita = await novaVisita({
      lead_id: lead, client_id: null, area_sqm: 180.5, outcome_notes: "Escada sem elevador",
    });

    await expect(pool.query(lerSql(ROLLBACK_102)))
      .rejects.toThrow(/ROLLBACK_RECUSADO/);

    // A tabela continua, a visita continua, e o que nela foi medido continua.
    const { rows } = await pool.query(
      "SELECT id, area_sqm, outcome_notes FROM public.crm_visits WHERE id=$1", [visita]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].area_sqm)).toBe(180.5);
    expect(rows[0].outcome_notes).toBe("Escada sem elevador");

    // A lead também não foi levada à frente.
    const { rows: leads } = await pool.query(
      "SELECT count(*)::int n FROM public.crm_leads WHERE id=$1", [lead]);
    expect(leads[0].n).toBe(1);

    // E a tabela está inteira, não meio desmontada.
    const { rows: r } = await pool.query(`
      SELECT to_regclass('public.crm_visits') AS t,
             (SELECT count(*)::int FROM pg_policies
               WHERE schemaname='public' AND tablename='crm_visits') AS politicas`);
    expect(r[0].t).toBe("crm_visits");
    expect(r[0].politicas).toBeGreaterThan(0);
  });

  it("depois de a operação decidir o destino dos dados, o rollback passa e a 102 volta", LENTO, async () => {
    await cadeiaDoMaster(true);
    await novaVisita();

    // A decisão é de quem opera, e é explícita — não é o rollback a tomá-la.
    await pool.query("DELETE FROM public.crm_visits");

    await pool.query(lerSql(ROLLBACK_102));
    const { rows: vazio } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(vazio[0].t).toBeNull();

    await pool.query(lerSql(M_102));
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBe("crm_visits");
  });

  it("sem tabela nenhuma, o rollback é um no-op idempotente", LENTO, async () => {
    await cadeiaDoMaster(true);
    await pool.query(lerSql(ROLLBACK_102));
    // Segunda vez: não rebenta, não faz nada.
    await pool.query(lerSql(ROLLBACK_102));
    const { rows } = await pool.query("SELECT to_regclass('public.crm_visits') AS t");
    expect(rows[0].t).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("o namespace", () => {
  it("a 102 é do CRM, e a frente de colaboradores usou sufixos", LENTO, async () => {
    const { readdirSync } = await import("node:fs");
    const nomes = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"));

    expect(nomes).toContain("102_crm_visitas_comerciais.sql");
    // `101b` e `101c` existem para NÃO terem roubado este número.
    expect(nomes.filter((n) => /^102[a-z]?_/.test(n))).toEqual([
      "102_crm_visitas_comerciais.sql",
    ]);
  });
});
