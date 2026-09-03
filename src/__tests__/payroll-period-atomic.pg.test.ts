// ============================================================================
// 096 — segurança de período da folha
// ============================================================================
//
// ÂMBITO: PAYROLL_PERIOD_SAFETY_ONLY. Nada de cálculo novo — as funções recebem
// valores já calculados. O que se prova aqui é o período, e a atomicidade entre
// a folha e o caixa (a P0B, que `markPayrollPaid` admitia por resolver).
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `folhaper-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLAB1 = "c1c1c1c1-1111-4111-8111-111111111111";
const COLAB2 = "c2c2c2c2-2222-4222-8222-222222222222";

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
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text NOT NULL, category text, date date NOT NULL,
      expense_category_id uuid, reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado',
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX cash_flow_ref_unico
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    -- A 008, reduzida ao que estas funções tocam. Sem índice único sobre
    -- (company_id, collaborator_id, period_year, period_month) — de propósito:
    -- é assim que este repositório o define, e as funções da 096 não dependem
    -- dele.
    CREATE TABLE public.payroll_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      period_year integer NOT NULL,
      period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
      contracted_hours numeric(6,2), worked_hours numeric(6,2) DEFAULT 0,
      overtime_hours numeric(6,2) DEFAULT 0, absence_hours numeric(6,2) DEFAULT 0,
      days_worked integer DEFAULT 0, hourly_rate numeric(8,2),
      gross_salary numeric(10,2) DEFAULT 0, meal_allowance numeric(10,2) DEFAULT 0,
      overtime_bonus numeric(10,2) DEFAULT 0, absence_deductions numeric(10,2) DEFAULT 0,
      other_deductions numeric(10,2) DEFAULT 0, other_additions numeric(10,2) DEFAULT 0,
      net_salary numeric(10,2) DEFAULT 0,
      status text DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'aprovado', 'pago')),
      notes text, approved_by uuid REFERENCES public.profiles(id),
      paid_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_payroll_company_period ON public.payroll_records(company_id, period_year, period_month);

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/096_payroll_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query(
    "INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora'), ($3, $2, 'Ana'), ($4, $2, 'Bea')",
    [ACTOR, EMPRESA, COLAB1, COLAB2],
  );
}

const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nFolhas = async () => Number((await pool.query("select count(*) n from public.payroll_records")).rows[0].n);
const nCaixa = async () => Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);
const folha = async (id: string) =>
  (await pool.query("SELECT * FROM public.payroll_records WHERE id = $1", [id])).rows[0];

async function semearFolha(opts?: {
  colaborador?: string;
  ano?: number;
  mes?: number;
  estado?: string;
  liquido?: number;
}) {
  const { rows } = await pool.query(
    `INSERT INTO public.payroll_records
       (company_id, collaborator_id, period_year, period_month, net_salary, gross_salary, status)
     VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
    [
      EMPRESA,
      opts?.colaborador ?? COLAB1,
      opts?.ano ?? 2026,
      opts?.mes ?? 7,
      opts?.liquido ?? 1000,
      opts?.estado ?? "rascunho",
    ],
  );
  return rows[0].id as string;
}

const LINHAS = (liquido = 1000) =>
  JSON.stringify([
    { collaborator_id: COLAB1, worked_hours: 160, gross_salary: liquido, net_salary: liquido, days_worked: 20 },
    { collaborator_id: COLAB2, worked_hours: 150, gross_salary: liquido, net_salary: liquido, days_worked: 19 },
  ]);

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "folhaper",
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

describe("096 — MATERIALIZAR a folha calculada", () => {
  it("mês aberto: grava as linhas que recebeu", async () => {
    const { rows } = await pool.query(
      "SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, $3)",
      [EMPRESA, LINHAS(), ACTOR],
    );
    expect(rows[0].gravados).toBe(2);
    expect(rows[0].preservados).toBe(0);
    expect(await nFolhas()).toBe(2);
  }, 120_000);

  it("segunda passagem actualiza em vez de duplicar — sem índice único nenhum", async () => {
    await pool.query("SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, $3)", [
      EMPRESA,
      LINHAS(1000),
      ACTOR,
    ]);
    await pool.query("SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, $3)", [
      EMPRESA,
      LINHAS(1500),
      ACTOR,
    ]);
    expect(await nFolhas()).toBe(2);
    const { rows } = await pool.query("SELECT DISTINCT net_salary FROM public.payroll_records");
    expect(rows.map((r) => Number(r.net_salary))).toEqual([1500]);
  }, 120_000);

  it("🔴 uma folha aprovada ou paga NÃO é reescrita por um recálculo", async () => {
    await semearFolha({ colaborador: COLAB1, ano: 2026, mes: 7, estado: "aprovado", liquido: 999 });
    await semearFolha({ colaborador: COLAB2, ano: 2026, mes: 7, estado: "pago", liquido: 888 });

    const { rows } = await pool.query(
      "SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, $3)",
      [EMPRESA, LINHAS(1500), ACTOR],
    );
    expect(rows[0].preservados).toBe(2);
    expect(rows[0].gravados).toBe(0);

    const { rows: vals } = await pool.query(
      "SELECT net_salary FROM public.payroll_records ORDER BY net_salary",
    );
    expect(vals.map((r) => Number(r.net_salary))).toEqual([888, 999]);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, $3)", [
        EMPRESA,
        LINHAS(),
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(await nFolhas()).toBe(0);
  }, 120_000);

  it("recusa entrada inválida antes de escrever", async () => {
    await expect(
      pool.query("SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, NULL)", [
        EMPRESA,
        JSON.stringify([{ worked_hours: 10 }]),
      ]),
    ).rejects.toThrow(/PAYROLL_RECORD_WITHOUT_COLLABORATOR/);
    await expect(
      pool.query("SELECT * FROM public.upsert_payroll_records_atomic($1, 2026, 7, $2::jsonb, NULL)", [
        EMPRESA,
        JSON.stringify({ nao: "array" }),
      ]),
    ).rejects.toThrow(/PAYROLL_RECORDS_INVALID/);
    expect(await nFolhas()).toBe(0);
  }, 120_000);
});

describe("096 — AJUSTAR", () => {
  it("mês aberto: grava os valores recalculados", async () => {
    const id = await semearFolha();
    await pool.query("SELECT * FROM public.adjust_payroll_record_atomic($1, $2, $3::jsonb, $4)", [
      EMPRESA,
      id,
      JSON.stringify({ other_additions: 50, net_salary: 1050, notes: "prémio" }),
      ACTOR,
    ]);
    const f = await folha(id);
    expect(Number(f.net_salary)).toBe(1050);
    expect(f.notes).toBe("prémio");
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    const id = await semearFolha();
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.adjust_payroll_record_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA,
        id,
        JSON.stringify({ net_salary: 1050 }),
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(Number((await folha(id)).net_salary)).toBe(1000);
  }, 120_000);

  it("uma folha aprovada já não se ajusta", async () => {
    const id = await semearFolha({ estado: "aprovado" });
    await expect(
      pool.query("SELECT * FROM public.adjust_payroll_record_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA,
        id,
        JSON.stringify({ net_salary: 1 }),
        ACTOR,
      ]),
    ).rejects.toThrow(/PAYROLL_RECORD_NOT_DRAFT/);
    expect(Number((await folha(id)).net_salary)).toBe(1000);
  }, 120_000);

  it("campos fora da lista branca são recusados", async () => {
    const id = await semearFolha();
    await expect(
      pool.query("SELECT * FROM public.adjust_payroll_record_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA,
        id,
        JSON.stringify({ status: "pago" }),
        ACTOR,
      ]),
    ).rejects.toThrow(/PAYROLL_FIELD_NOT_EDITABLE/);
    expect((await folha(id)).status).toBe("rascunho");
  }, 120_000);
});

describe("096 — APROVAR um lote de N competências", () => {
  it("aprova o lote inteiro e conta os que já estavam aprovados", async () => {
    const a = await semearFolha({ ano: 2026, mes: 7 });
    const b = await semearFolha({ colaborador: COLAB2, ano: 2026, mes: 8, estado: "aprovado" });

    const { rows } = await pool.query("SELECT * FROM public.approve_payroll_records_atomic($1, $2::uuid[], $3)", [
      EMPRESA,
      [a, b],
      ACTOR,
    ]);
    expect(rows[0].aprovados).toBe(1);
    expect(rows[0].ja_aprovados).toBe(1);
    expect((await folha(a)).status).toBe("aprovado");
    expect((await folha(a)).approved_by).toBe(ACTOR);
  }, 120_000);

  it("🔴 QUALQUER competência do lote fechada: ZERO ESCRITA", async () => {
    for (const mes of [7, 8]) {
      await baseline();
      const a = await semearFolha({ ano: 2026, mes: 7 });
      const b = await semearFolha({ colaborador: COLAB2, ano: 2026, mes: 8 });
      await fechar(2026, mes);

      await expect(
        pool.query("SELECT * FROM public.approve_payroll_records_atomic($1, $2::uuid[], $3)", [EMPRESA, [a, b], ACTOR]),
        `mês ${mes}`,
      ).rejects.toThrow(new RegExp(`FINANCIAL_PERIOD_CLOSED: 2026-0${mes}`));
      expect((await folha(a)).status).toBe("rascunho");
      expect((await folha(b)).status).toBe("rascunho");
    }
  }, 180_000);

  it("falha fechada: um id de outra empresa faz o lote inteiro recuar", async () => {
    const a = await semearFolha();
    await expect(
      pool.query("SELECT * FROM public.approve_payroll_records_atomic($1, $2::uuid[], $3)", [
        EMPRESA,
        [a, "99999999-9999-4999-8999-999999999999"],
        ACTOR,
      ]),
    ).rejects.toThrow(/PAYROLL_SELECTION_STALE/);
    expect((await folha(a)).status).toBe("rascunho");
  }, 120_000);

  it("🔴 uma folha PAGA não volta a aprovada", async () => {
    const a = await semearFolha({ estado: "pago" });
    await expect(
      pool.query("SELECT * FROM public.approve_payroll_records_atomic($1, $2::uuid[], $3)", [EMPRESA, [a], ACTOR]),
    ).rejects.toThrow(/PAYROLL_ALREADY_PAID/);
    expect((await folha(a)).status).toBe("pago");
  }, 120_000);

  it("um lote vazio não é erro", async () => {
    const { rows } = await pool.query("SELECT * FROM public.approve_payroll_records_atomic($1, $2::uuid[], $3)", [
      EMPRESA,
      [],
      ACTOR,
    ]);
    expect([rows[0].aprovados, rows[0].ja_aprovados]).toEqual([0, 0]);
  }, 120_000);
});

describe("096 — PAGAR: a folha e o caixa numa transação (P0B)", () => {
  it("marca como pago e cria a saída de caixa, na mesma escrita", async () => {
    const a = await semearFolha({ ano: 2026, mes: 7, estado: "aprovado", liquido: 1200 });
    const { rows } = await pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], $3::date, $4)", [
      EMPRESA,
      [a],
      "2026-07-28",
      ACTOR,
    ]);
    expect([rows[0].pagos, rows[0].movimentos]).toEqual([1, 1]);

    const f = await folha(a);
    expect(f.status).toBe("pago");
    expect(f.paid_at).toBeTruthy();

    const { rows: mov } = await pool.query(
      "SELECT *, to_char(date,'YYYY-MM-DD') d FROM public.cash_flow_entries WHERE reference_type = 'payroll'",
    );
    expect(mov).toHaveLength(1);
    expect(mov[0].type).toBe("saida");
    expect(Number(mov[0].amount)).toBe(1200);
    expect(mov[0].d).toBe("2026-07-28");
    expect(mov[0].description).toContain("Ana");
    expect(mov[0].description).toContain("7/2026");
  }, 120_000);

  it("🔴 nem folha paga nem caixa sozinho: o rollback desfaz os dois", async () => {
    const a = await semearFolha({ estado: "aprovado" });
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], NULL, $3)", [EMPRESA, [a], ACTOR]);
    await c.query("ROLLBACK");
    await c.end();

    expect((await folha(a)).status).toBe("aprovado");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 a COMPETÊNCIA fechada impede o pagamento", async () => {
    const a = await semearFolha({ ano: 2026, mes: 7, estado: "aprovado" });
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-08-05'::date, $3)", [
        EMPRESA,
        [a],
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await folha(a)).status).toBe("aprovado");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 o DIA DO PAGAMENTO fechado também impede — a competência não chega", async () => {
    const a = await semearFolha({ ano: 2026, mes: 7, estado: "aprovado" });
    await fechar(2026, 8);
    await expect(
      pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-08-05'::date, $3)", [
        EMPRESA,
        [a],
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("um lote que atravessa meses tranca todos, e o dia do pagamento também", async () => {
    const a = await semearFolha({ ano: 2026, mes: 5, estado: "aprovado" });
    const b = await semearFolha({ colaborador: COLAB2, ano: 2026, mes: 6, estado: "aprovado" });

    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-07-05'::date, $3)", [
      EMPRESA,
      [a, b],
      ACTOR,
    ]);
    const { rows } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.chave))).toEqual([202605, 202606, 202607]);
    await c.query("COMMIT");
    await c.end();

    expect(await nCaixa()).toBe(2);
  }, 120_000);

  it("idempotência: repetir não duplica movimento nem reescreve o pagamento", async () => {
    const a = await semearFolha({ estado: "aprovado" });
    await pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-07-28'::date, $3)", [
      EMPRESA,
      [a],
      ACTOR,
    ]);
    const { rows } = await pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], $3::date, $4)", [
      EMPRESA,
      [a],
      "2026-07-29",
      ACTOR,
    ]);
    expect([rows[0].pagos, rows[0].movimentos]).toEqual([0, 0]);
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("uma folha sem valor líquido não gera movimento, mas fica paga", async () => {
    const a = await semearFolha({ estado: "aprovado", liquido: 0 });
    const { rows } = await pool.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], NULL, $3)", [
      EMPRESA,
      [a],
      ACTOR,
    ]);
    expect([rows[0].pagos, rows[0].movimentos]).toEqual([1, 0]);
    expect((await folha(a)).status).toBe("pago");
  }, 120_000);
});

describe("096 — concorrência writer vs fecho", () => {
  it("writer primeiro: a folha e o caixa entram inteiros, e o fecho decide depois", async () => {
    const a = await semearFolha({ ano: 2026, mes: 9, estado: "aprovado" });
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    await writer.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-09-28'::date, $3)", [
      EMPRESA,
      [a],
      ACTOR,
    ]);

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nCaixa()).toBe(1);
    // A saída de salário não tem categoria estruturada — é bloqueador.
    expect(r.rows[0].fechado).toBe(false);
    expect(r.rows[0].bloqueadores.despesas_sem_categoria).toBe(1);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const a = await semearFolha({ ano: 2026, mes: 9, estado: "aprovado" });
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-09-28'::date, $3)", [
          EMPRESA,
          [a],
          ACTOR,
        ]);
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
    expect((await folha(a)).status).toBe("aprovado");
    expect(await nCaixa()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("lotes com ids sobrepostos por ordens inversas: deadlock zero", async () => {
    const a = await semearFolha({ ano: 2026, mes: 5, estado: "aprovado" });
    const b = await semearFolha({ colaborador: COLAB2, ano: 2026, mes: 6, estado: "aprovado" });

    const aprovar = async (ids: string[], marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.mark_payroll_paid_atomic($1, $2::uuid[], '2026-07-05'::date, $3)", [
          EMPRESA,
          ids,
          ACTOR,
        ]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    const r = await Promise.all([aprovar([a, b], "AB"), aprovar([b, a], "BA")]);
    expect(r).toEqual(["AB", "BA"]);
    expect(await nCaixa()).toBe(2);
  }, 120_000);
});

describe("096 — superfície", () => {
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    [
      "upsert_payroll_records_atomic",
      "p_company_id uuid, p_period_year integer, p_period_month integer, p_records jsonb, p_actor uuid",
    ],
    ["adjust_payroll_record_atomic", "p_company_id uuid, p_record_id uuid, p_patch jsonb, p_actor uuid"],
    ["approve_payroll_records_atomic", "p_company_id uuid, p_ids uuid[], p_actor uuid"],
    ["mark_payroll_paid_atomic", "p_company_id uuid, p_ids uuid[], p_paid_on date, p_actor uuid"],
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
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_periods_open_locked_many(uuid, integer[]) CASCADE");
    const sql = readFileSync(join(ROOT, "supabase/migrations/096_payroll_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/096_PRECONDITION_FAILED/);
  }, 120_000);
});
