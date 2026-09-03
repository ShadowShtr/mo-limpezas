// ============================================================================
// 093 — fluxo de caixa manual dentro do protocolo de período
// ============================================================================
//
// A guarda destes três writers vivia na server action, uma viagem antes da
// escrita. Aqui prova-se que passou para dentro da transação — e que a edição
// protege os DOIS meses, não só o de destino.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `cfper-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

async function ligacao() {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE public.financial_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, year integer NOT NULL, month integer NOT NULL,
      status text NOT NULL DEFAULT 'open',
      closed_at timestamptz, closed_by uuid,
      reopened_at timestamptz, reopened_by uuid, reopen_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, year, month)
    );
    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, actor_id uuid NOT NULL, action text NOT NULL,
      entity_type text NOT NULL DEFAULT 'timesheet', entity_id text,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, full_name text);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, period_start date
    );
    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, transaction_date date
    );
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL DEFAULT 'pendente',
      period_year integer NOT NULL, period_month integer NOT NULL
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN ('entrada', 'saida')),
      amount numeric(10,2) NOT NULL,
      description text NOT NULL,
      category text DEFAULT 'outro'
        CHECK (category IN ('faturacao', 'salario', 'despesa', 'fornecedor', 'outro')),
      date date NOT NULL,
      reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado'
        CHECK (status IN ('pendente', 'confirmado')),
      notes text,
      expense_category_id uuid,
      created_by uuid REFERENCES public.profiles(id),
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX cash_flow_ref_unico
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    CREATE TABLE public.bank_reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      bank_transaction_id uuid,
      cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'suggested'
    );

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-093-cashflow-rpcs.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/093_cashflow_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [
    ACTOR,
    EMPRESA,
  ]);
}

/** Fecha o mês directamente — ver a nota da suite da 092: o palco não pode
 *  depender de o fecho pela RPC não encontrar bloqueadores. */
const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nCaixa = async () => Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);

const linha = async (id: string) =>
  (
    await pool.query(
      "SELECT *, to_char(date, 'YYYY-MM-DD') d FROM public.cash_flow_entries WHERE id = $1",
      [id],
    )
  ).rows[0];

async function semear(data: string, opts?: { referencia?: boolean; status?: string }) {
  const { rows } = await pool.query(
    `INSERT INTO public.cash_flow_entries
       (company_id, type, amount, description, category, date, status, reference_type, reference_id)
     VALUES ($1, 'saida', 50, 'semeado', 'despesa', $2::date, $3, $4, $5) RETURNING id`,
    [
      EMPRESA,
      data,
      opts?.status ?? "confirmado",
      opts?.referencia ? "invoice" : null,
      opts?.referencia ? "99999999-9999-4999-8999-999999999999" : null,
    ],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "cfper",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB", "maintenance_work_mem=8MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
  await pool.query(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

beforeEach(async () => {
  await baseline();
});

describe("093 — CREATE", () => {
  it("mês aberto: cria", async () => {
    const { rows } = await pool.query(
      "SELECT * FROM public.create_cashflow_entry_atomic($1, 'saida', 120, 'Luz', 'despesa', '2026-07-10'::date, 'confirmado', NULL, NULL, $2)",
      [EMPRESA, ACTOR],
    );
    const l = await linha(rows[0].entry_id);
    expect(l.d).toBe("2026-07-10");
    expect(l.reference_type).toBeNull();
    expect(l.created_by).toBe(ACTOR);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 7);
    await expect(
      pool.query(
        "SELECT * FROM public.create_cashflow_entry_atomic($1, 'saida', 120, 'Luz', 'despesa', '2026-07-10'::date, 'confirmado', NULL, NULL, $2)",
        [EMPRESA, ACTOR],
      ),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("o período é o da DATA DO MOVIMENTO, não o de hoje", async () => {
    // Um movimento lançado hoje com data de Julho pertence a Julho.
    await fechar(2026, 9);
    const { rows } = await pool.query(
      "SELECT * FROM public.create_cashflow_entry_atomic($1, 'entrada', 10, 'x', 'outro', '2026-07-10'::date, 'confirmado', NULL, NULL, NULL)",
      [EMPRESA],
    );
    expect(rows[0].entry_id).toBeTruthy();
  }, 120_000);

  it("valida os argumentos antes de tocar na base", async () => {
    const casos: [string, RegExp][] = [
      ["SELECT public.create_cashflow_entry_atomic($1, 'x', 10, 'd', 'outro', '2026-07-10'::date)", /CASHFLOW_TYPE_INVALID/],
      ["SELECT public.create_cashflow_entry_atomic($1, 'saida', 10, '  ', 'outro', '2026-07-10'::date)", /CASHFLOW_DESCRIPTION_REQUIRED/],
      ["SELECT public.create_cashflow_entry_atomic($1, 'saida', 0, 'd', 'outro', '2026-07-10'::date)", /CASHFLOW_AMOUNT_INVALID/],
      ["SELECT public.create_cashflow_entry_atomic($1, 'saida', -1, 'd', 'outro', '2026-07-10'::date)", /CASHFLOW_AMOUNT_INVALID/],
      ["SELECT public.create_cashflow_entry_atomic($1, 'saida', 10, 'd', 'outro', '2026-07-10'::date, 'x')", /CASHFLOW_STATUS_INVALID/],
      ["SELECT public.create_cashflow_entry_atomic($1, 'saida', 10, 'd', 'outro', NULL)", /CASHFLOW_INVALID_ARGS/],
    ];
    for (const [sql, erro] of casos) {
      await expect(pool.query(sql, [EMPRESA]), sql).rejects.toThrow(erro);
    }
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("não há caminho para fabricar um movimento com origem", async () => {
    // `reference_type`/`reference_id` não são parâmetros. Um movimento ligado
    // pertence à sua origem, e é ela que o cria dentro do seu protocolo.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM information_schema.parameters
        WHERE specific_schema = 'public'
          AND specific_name LIKE 'create_cashflow_entry_atomic%'
          AND parameter_name IN ('p_reference_type', 'p_reference_id')`,
    );
    expect(rows[0].n).toBe(0);
  }, 120_000);
});

describe("093 — UPDATE: origem e destino", () => {
  it("mês aberto: edita", async () => {
    const id = await semear("2026-07-10");
    await pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ description: "novo" }),
    ]);
    expect((await linha(id)).description).toBe("novo");
  }, 120_000);

  it("🔴 mês de ORIGEM fechado: ZERO ESCRITA", async () => {
    const id = await semear("2026-07-10");
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ date: "2026-08-10" }),
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await linha(id)).d).toBe("2026-07-10");
  }, 120_000);

  it("🔴 mês de DESTINO fechado: ZERO ESCRITA", async () => {
    const id = await semear("2026-07-10");
    await fechar(2026, 8);
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ date: "2026-08-10" }),
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
    expect((await linha(id)).d).toBe("2026-07-10");
  }, 120_000);

  it("mover a data com os dois abertos passa, e tranca os dois", async () => {
    const id = await semear("2026-07-10");
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ date: "2026-08-10" }),
    ]);
    const { rows } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.chave))).toEqual([202607, 202608]);
    await c.query("COMMIT");
    await c.end();
    expect((await linha(id)).d).toBe("2026-08-10");
  }, 120_000);

  it("sem `date` no patch é um lock só", async () => {
    const id = await semear("2026-07-10");
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ amount: 99 }),
    ]);
    const { rows } = await c.query(
      `SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
    );
    expect(rows[0].n).toBe(1);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("as guardas da 082 continuam todas lá", async () => {
    const comOrigem = await semear("2026-07-10", { referencia: true });
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, '{}'::jsonb)", [EMPRESA, comOrigem]),
    ).rejects.toThrow(/CASHFLOW_MANAGED_BY_ORIGIN/);

    const conciliado = await semear("2026-07-10");
    await pool.query(
      "INSERT INTO public.bank_reconciliation_matches (company_id, cash_flow_entry_id, status) VALUES ($1, $2, 'confirmed')",
      [EMPRESA, conciliado],
    );
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, '{}'::jsonb)", [EMPRESA, conciliado]),
    ).rejects.toThrow(/CASHFLOW_RECONCILED/);

    const normal = await semear("2026-07-10");
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        normal,
        JSON.stringify({ company_id: OUTRA }),
      ]),
    ).rejects.toThrow(/CASHFLOW_FIELD_NOT_EDITABLE/);

    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, '{}'::jsonb)", [
        EMPRESA,
        "88888888-8888-4888-8888-888888888888",
      ]),
    ).rejects.toThrow(/CASHFLOW_NOT_FOUND/);
  }, 120_000);

  it("🔴 a guarda de linha corre ANTES do lock de período", async () => {
    // Um movimento com origem num mês fechado tem de dar
    // CASHFLOW_MANAGED_BY_ORIGIN, e não FINANCIAL_PERIOD_CLOSED: a ordem da 090
    // é linhas primeiro, períodos depois. Trocá-la mudaria a mensagem que a
    // pessoa vê e escondia a causa verdadeira.
    const id = await semear("2026-07-10", { referencia: true });
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, '{}'::jsonb)", [EMPRESA, id]),
    ).rejects.toThrow(/CASHFLOW_MANAGED_BY_ORIGIN/);
  }, 120_000);
});

describe("093 — DELETE", () => {
  it("mês aberto: apaga", async () => {
    const id = await semear("2026-07-10");
    const { rows } = await pool.query("SELECT * FROM public.delete_cashflow_entry_atomic($1, $2)", [EMPRESA, id]);
    expect(rows[0].apagados).toBe(1);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    const id = await semear("2026-07-10");
    await fechar(2026, 7);
    await expect(pool.query("SELECT * FROM public.delete_cashflow_entry_atomic($1, $2)", [EMPRESA, id])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-07/,
    );
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("as guardas da 082 continuam lá", async () => {
    const comOrigem = await semear("2026-07-10", { referencia: true });
    await expect(
      pool.query("SELECT * FROM public.delete_cashflow_entry_atomic($1, $2)", [EMPRESA, comOrigem]),
    ).rejects.toThrow(/CASHFLOW_MANAGED_BY_ORIGIN/);
    expect(await nCaixa()).toBe(1);
  }, 120_000);
});

describe("093 — concorrência writer vs fecho", () => {
  it("writer primeiro: o movimento entra inteiro, e o fecho decide depois", async () => {
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    // Saída sem categoria estruturada — um dos quatro bloqueadores do fecho.
    await writer.query(
      "SELECT * FROM public.create_cashflow_entry_atomic($1, 'saida', 10, 'x', 'despesa', '2026-09-10'::date, 'confirmado', NULL, NULL, NULL)",
      [EMPRESA],
    );

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nCaixa()).toBe(1);
    expect(r.rows[0].fechado).toBe(false);
    expect(r.rows[0].bloqueadores.saidas_sem_categoria).toBe(1);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query(
          "SELECT * FROM public.create_cashflow_entry_atomic($1, 'entrada', 10, 'x', 'outro', '2026-09-10'::date, 'confirmado', NULL, NULL, NULL)",
          [EMPRESA],
        );
        await writer.query("COMMIT");
        return "escreveu";
      } catch (e) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((e as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    await fecho.query("COMMIT");

    expect(await promessa).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    expect(await nCaixa()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("movimentos inversos concorrentes: deadlock zero", async () => {
    const a = await semear("2026-07-10");
    const b = await semear("2026-08-10");

    const mover = async (id: string, para: string, marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.update_cashflow_entry_atomic($1, $2, $3::jsonb)", [
          EMPRESA,
          id,
          JSON.stringify({ date: para }),
        ]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    expect(await Promise.all([mover(a, "2026-08-15", "A"), mover(b, "2026-07-15", "B")])).toEqual(["A", "B"]);
  }, 120_000);
});

describe("093 — superfície", () => {
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    [
      "create_cashflow_entry_atomic",
      "p_company_id uuid, p_type text, p_amount numeric, p_description text, p_category text, p_date date, p_status text, p_notes text, p_expense_category_id uuid, p_actor uuid",
    ],
    ["update_cashflow_entry_atomic", "p_company_id uuid, p_entry_id uuid, p_patch jsonb"],
    ["delete_cashflow_entry_atomic", "p_company_id uuid, p_entry_id uuid"],
  ];

  it("cada função existe com a assinatura EXACTA do contrato", async () => {
    for (const [nome, assinatura] of ASSINATURAS) {
      const { rows } = await pool.query(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [nome],
      );
      expect(rows.map((r) => r.args), `${nome} tem de existir`).toContain(assinatura);
    }
  }, 120_000);

  it("nenhuma é SECURITY DEFINER, e anon/authenticated não executam", async () => {
    const { rows: def } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND p.proname = ANY($1::text[])`,
      [ASSINATURAS.map(([n]) => n)],
    );
    expect(def.map((r) => r.proname)).toEqual([]);

    for (const [nome, assinatura] of ASSINATURAS) {
      const tipos = assinatura
        .split(", ")
        .map((a) => a.split(" ").slice(1).join(" "))
        .join(", ");
      const alvo = `public.${nome}(${tipos})`;
      for (const papel of ["anon", "authenticated", "public"]) {
        const { rows } = await pool.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS pode", [papel, alvo]);
        expect(rows[0].pode, `${papel} NÃO pode executar ${nome}`).toBe(false);
      }
      const { rows } = await pool.query("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS pode", [alvo]);
      expect(rows[0].pode, `service_role tem de poder executar ${nome}`).toBe(true);
    }
  }, 120_000);

  it("a precondição recusa se a fundação 090 não estiver aplicada", async () => {
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_period_dates_open_locked(uuid, date[]) CASCADE");
    const sql = readFileSync(join(ROOT, "supabase/migrations/093_cashflow_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/093_PRECONDITION_FAILED/);
  }, 120_000);
});
