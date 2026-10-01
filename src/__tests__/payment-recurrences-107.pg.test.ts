// ============================================================================
// 107 — recorrência dos fixos, contra Postgres real
// ============================================================================
//
// O que se prova aqui, e não se prova a ler o SQL:
//
//   · um fixo gera-se nos meses certos e com o vencimento certo, incluindo o
//     dia 31 num mês de 30 e num Fevereiro;
//   · gerar duas vezes não duplica, e uma linha apagada não reaparece;
//   · nada nasce antes de Novembro de 2026, peça o chamador o que pedir;
//   · um trimestral só aparece de três em três meses;
//   · tornar recorrente um fixo existente não lhe toca no valor nem nos anexos;
//   · parar de repetir apaga só o que é futuro, pendente e sem nada de
//     ninguém — um anexo (coluna ou tabela), um pagamento ou um movimento de
//     caixa mantêm a linha;
//   · criar um fixo recorrente num mês fechado não deixa nada para trás;
//   · `anon` e `authenticated` não têm privilégio nenhum sobre o molde.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `rec107-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LENTO = 120_000;

let container: PostgresContainer;
let pool: pg.Pool;

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
    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text, category text, date date NOT NULL,
      expense_category_id uuid, reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado', notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX cash_flow_ref_unico
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      kind text NOT NULL, description text NOT NULL,
      amount numeric(10,2), due_date date,
      expense_category_id uuid, direct_debit boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'pendente',
      recurring boolean NOT NULL DEFAULT false,
      period_year integer NOT NULL,
      period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
      notes text, sort_order integer NOT NULL DEFAULT 0,
      paid_at timestamptz, source_id uuid,
      attachment_url text, attachment_name text, attachment_size bigint, attachment_mime text,
      created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.payment_cashflow_provenance (
      cash_flow_entry_id uuid PRIMARY KEY
        REFERENCES public.cash_flow_entries(id) ON DELETE RESTRICT,
      company_id uuid NOT NULL,
      payment_id uuid NOT NULL
        REFERENCES public.fixed_variable_payments(id) ON DELETE RESTRICT,
      origin text NOT NULL CHECK (origin IN ('created_by_mark', 'adopted_existing')),
      prestate_date date, prestate_expense_category_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.bank_reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, bank_transaction_id uuid,
      cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'suggested'
    );
    -- A 074, polimórfica e SEM FK para o pagamento — é isso que o teste da
    -- paragem tem de respeitar.
    CREATE TABLE public.attachments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, parent_type text NOT NULL, parent_id uuid NOT NULL,
      storage_bucket text NOT NULL, storage_path text NOT NULL,
      original_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-092-payment-rpcs.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/092_payments_period_atomic.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/107_payment_recurrences.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A')", [EMPRESA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [ACTOR, EMPRESA]);
}

const fechar = (ano: number, mes: number) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [EMPRESA, ano, mes, ACTOR],
  );

/** Um molde semeado directamente, como a semente inicial do dono fará. */
async function molde(opts: {
  descricao?: string;
  valor?: number | null;
  intervalo?: number;
  dia?: number | null;
  ate: number;
}) {
  const { rows } = await pool.query(
    `INSERT INTO public.payment_recurrences
       (company_id, description, amount, interval_months, due_day, generated_through)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [EMPRESA, opts.descricao ?? "Renda", opts.valor === undefined ? 650 : opts.valor,
      opts.intervalo ?? 1, opts.dia === undefined ? 9 : opts.dia, opts.ate],
  );
  return rows[0].id as string;
}

const gerar = async (de: number, ate: number, rec: string | null = null) =>
  (await pool.query(
    "SELECT * FROM public.generate_recurring_payments_atomic($1, $2, $3, $4)",
    [EMPRESA, de, ate, rec],
  )).rows[0] as { criados: number; saltados_fechados: number };

const linhas = async (rec: string) =>
  (await pool.query(
    `SELECT period_year * 100 + period_month AS k, to_char(due_date, 'YYYY-MM-DD') AS venc,
            amount, status, kind, recurring, attachment_url
       FROM public.fixed_variable_payments WHERE recurrence_id = $1 ORDER BY 1`,
    [rec],
  )).rows;

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "rec107",
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
}, LENTO);

describe("107 — gerar", () => {
  it("mensal: quatro meses à frente, vencimento no dia do molde", async () => {
    const rec = await molde({ ate: 202610 });
    expect(await gerar(202611, 202702)).toEqual({ criados: 4, saltados_fechados: 0 });
    const r = await linhas(rec);
    expect(r.map((l) => l.venc)).toEqual(["2026-11-09", "2026-12-09", "2027-01-09", "2027-02-09"]);
    expect(r.every((l) => l.kind === "fixo" && l.status === "pendente" && l.recurring)).toBe(true);
    expect(r.every((l) => Number(l.amount) === 650)).toBe(true);
  }, LENTO);

  it("dia 31 cai no último dia de meses mais curtos", async () => {
    const rec = await molde({ dia: 31, ate: 202610 });
    await gerar(202611, 202702);
    expect((await linhas(rec)).map((l) => l.venc)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  }, LENTO);

  it("valor em branco no molde → lembrete sem valor (contas de luz)", async () => {
    const rec = await molde({ valor: null, ate: 202610 });
    await gerar(202611, 202611);
    expect((await linhas(rec))[0].amount).toBeNull();
  }, LENTO);

  it("🔴 idempotente: a segunda corrida cria zero", async () => {
    const rec = await molde({ ate: 202610 });
    await gerar(202611, 202702);
    expect(await gerar(202611, 202702)).toEqual({ criados: 0, saltados_fechados: 0 });
    expect(await linhas(rec)).toHaveLength(4);
  }, LENTO);

  it("🔴 uma linha gerada e apagada não reaparece", async () => {
    const rec = await molde({ ate: 202610 });
    await gerar(202611, 202612);
    await pool.query("DELETE FROM public.fixed_variable_payments WHERE recurrence_id = $1 AND period_month = 12", [rec]);
    await gerar(202611, 202701);
    expect((await linhas(rec)).map((l) => l.k)).toEqual([202611, 202701]);
  }, LENTO);

  it("🔴 piso de Novembro/2026: Outubro nunca é gerado, mesmo pedido", async () => {
    const rec = await molde({ ate: 202609 });
    await gerar(202610, 202612);
    expect((await linhas(rec)).map((l) => l.k)).toEqual([202611, 202612]);
  }, LENTO);

  it("o mês corrente não é recuperado: só se gera a partir de p_from_key", async () => {
    // Base em Setembro, cron a correr em Dezembro: Outubro e Novembro passam.
    const rec = await molde({ ate: 202609 });
    await gerar(202701, 202704);
    expect((await linhas(rec)).map((l) => l.k)).toEqual([202701, 202702, 202703, 202704]);
  }, LENTO);

  it("trimestral: só de três em três meses", async () => {
    const rec = await molde({ intervalo: 3, dia: 3, ate: 202705 });
    await gerar(202611, 202711);
    expect((await linhas(rec)).map((l) => l.venc)).toEqual(["2027-08-03", "2027-11-03"]);
  }, LENTO);

  it("um mês futuro fechado é saltado e contado, sem abortar os outros", async () => {
    const rec = await molde({ ate: 202610 });
    await fechar(2026, 12);
    expect(await gerar(202611, 202701)).toEqual({ criados: 2, saltados_fechados: 1 });
    expect((await linhas(rec)).map((l) => l.k)).toEqual([202611, 202701]);
  }, LENTO);

  it("recorrência parada não gera", async () => {
    const rec = await molde({ ate: 202610 });
    await pool.query("UPDATE public.payment_recurrences SET active = false WHERE id = $1", [rec]);
    expect((await gerar(202611, 202702)).criados).toBe(0);
  }, LENTO);

  it("linhas geradas nascem sem anexo", async () => {
    const rec = await molde({ ate: 202610 });
    await gerar(202611, 202611);
    expect((await linhas(rec))[0].attachment_url).toBeNull();
  }, LENTO);
});

describe("107 — tornar recorrente e criar recorrente", () => {
  it("🔴 tornar recorrente não toca no valor nem nos anexos da linha", async () => {
    const { rows } = await pool.query(
      `INSERT INTO public.fixed_variable_payments
         (company_id, kind, description, amount, due_date, period_year, period_month, status,
          attachment_url, attachment_name)
       VALUES ($1, 'fixo', 'Renda', 650, '2026-09-09', 2026, 9, 'pago', 'p/recibo.pdf', 'recibo.pdf')
       RETURNING *`,
      [EMPRESA],
    );
    const antes = rows[0];
    await fechar(2026, 9); // mês fechado não impede: é só metadado
    const { rows: m } = await pool.query(
      "SELECT * FROM public.make_payment_recurring_atomic($1, $2, 1::smallint, $3)",
      [EMPRESA, antes.id, ACTOR],
    );
    const depois = (await pool.query("SELECT * FROM public.fixed_variable_payments WHERE id = $1", [antes.id])).rows[0];
    expect(depois.recurrence_id).toBe(m[0].recurrence_id);
    for (const c of ["amount", "due_date", "status", "attachment_url", "attachment_name", "description"]) {
      expect(depois[c], c).toEqual(antes[c]);
    }
    const rec = (await pool.query("SELECT * FROM public.payment_recurrences WHERE id = $1", [m[0].recurrence_id])).rows[0];
    expect(rec.generated_through).toBe(202609);
    expect(rec.due_day).toBe(9);

    await expect(
      pool.query("SELECT * FROM public.make_payment_recurring_atomic($1, $2, 1::smallint, $3)", [EMPRESA, antes.id, ACTOR]),
    ).rejects.toThrow(/PAYMENT_ALREADY_RECURRING/);
  }, LENTO);

  it("um variável não pode ser recorrente", async () => {
    const { rows } = await pool.query(
      `INSERT INTO public.fixed_variable_payments (company_id, kind, description, period_year, period_month)
       VALUES ($1, 'variavel', 'X', 2026, 11) RETURNING id`, [EMPRESA]);
    await expect(
      pool.query("SELECT * FROM public.make_payment_recurring_atomic($1, $2, 1::smallint, NULL)", [EMPRESA, rows[0].id]),
    ).rejects.toThrow(/PAYMENT_RECURRENCE_ONLY_FIXED/);
  }, LENTO);

  it("criar recorrente: linha e molde juntos", async () => {
    const { rows } = await pool.query(
      `SELECT * FROM public.create_recurring_payment_atomic($1, 'Seguro', 83.56, '2026-11-03'::date, 2026, 11,
         3::smallint, NULL, false, NULL, $2)`,
      [EMPRESA, ACTOR],
    );
    const p = (await pool.query("SELECT * FROM public.fixed_variable_payments WHERE id = $1", [rows[0].payment_id])).rows[0];
    expect(p.recurrence_id).toBe(rows[0].recurrence_id);
    await gerar(202612, 202705);
    expect((await linhas(rows[0].recurrence_id)).map((l) => l.k)).toEqual([202611, 202702, 202705]);
  }, LENTO);

  it("🔴 criar recorrente num mês fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 11);
    await expect(
      pool.query(
        `SELECT * FROM public.create_recurring_payment_atomic($1, 'Seguro', 83.56, '2026-11-03'::date, 2026, 11,
           1::smallint, NULL, false, NULL, $2)`,
        [EMPRESA, ACTOR],
      ),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect(Number((await pool.query("SELECT count(*) n FROM public.payment_recurrences")).rows[0].n)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) n FROM public.fixed_variable_payments")).rows[0].n)).toBe(0);
  }, LENTO);
});

describe("107 — parar de repetir", () => {
  it("🔴 apaga só o futuro pendente e sem nada; anexos, pagos e caixa ficam", async () => {
    const rec = await molde({ ate: 202610 });
    await gerar(202611, 202704);
    const id = async (k: number) =>
      (await pool.query(
        "SELECT id FROM public.fixed_variable_payments WHERE recurrence_id = $1 AND period_year * 100 + period_month = $2",
        [rec, k],
      )).rows[0].id as string;

    // Novembro é o mês "corrente" desta paragem: fica sempre.
    // Dezembro: anexo na tabela 074. Janeiro: anexo na coluna 052.
    // Fevereiro: pago. Março: movimento de caixa ligado. Abril: limpo → apagado.
    await pool.query(
      `INSERT INTO public.attachments (company_id, parent_type, parent_id, storage_bucket, storage_path, original_name)
       VALUES ($1, 'fixed_variable_payment', $2, 'b', 'p/fatura.pdf', 'fatura.pdf')`,
      [EMPRESA, await id(202612)],
    );
    await pool.query("UPDATE public.fixed_variable_payments SET attachment_url = 'p/x.pdf' WHERE id = $1", [await id(202701)]);
    await pool.query("UPDATE public.fixed_variable_payments SET status = 'pago' WHERE id = $1", [await id(202702)]);
    await pool.query(
      `INSERT INTO public.cash_flow_entries (company_id, type, amount, date, reference_type, reference_id, status)
       VALUES ($1, 'saida', 650, '2027-03-09', 'fixed_variable_payment', $2, 'pendente')`,
      [EMPRESA, await id(202703)],
    );

    const { rows } = await pool.query(
      "SELECT * FROM public.stop_payment_recurrence_atomic($1, $2, 202611, $3)",
      [EMPRESA, rec, ACTOR],
    );
    expect(rows[0]).toEqual({ apagados: 1, mantidos: 4 });
    expect((await linhas(rec)).map((l) => l.k)).toEqual([202611, 202612, 202701, 202702, 202703]);
    expect(Number((await pool.query("SELECT count(*) n FROM public.attachments")).rows[0].n)).toBe(1);

    const r = (await pool.query("SELECT active, ended_at FROM public.payment_recurrences WHERE id = $1", [rec])).rows[0];
    expect(r.active).toBe(false);
    expect(r.ended_at).not.toBeNull();
    expect((await gerar(202611, 202708)).criados).toBe(0);
  }, LENTO);
});

describe("107 — ACL", () => {
  it("🔴 anon e authenticated sem nenhum dos oito privilégios; service_role só S/I/U", async () => {
    const privs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
    for (const papel of ["anon", "authenticated"]) {
      for (const p of privs) {
        const { rows } = await pool.query("SELECT has_table_privilege($1, 'public.payment_recurrences', $2) ok", [papel, p]);
        expect(rows[0].ok, `${papel} ${p}`).toBe(false);
      }
    }
    for (const p of privs) {
      const { rows } = await pool.query("SELECT has_table_privilege('service_role', 'public.payment_recurrences', $1) ok", [p]);
      expect(rows[0].ok, `service_role ${p}`).toBe(["SELECT", "INSERT", "UPDATE"].includes(p));
    }
    for (const papel of ["anon", "authenticated"]) {
      const { rows } = await pool.query(
        "SELECT has_function_privilege($1, 'public.generate_recurring_payments_atomic(uuid,integer,integer,uuid)', 'EXECUTE') ok",
        [papel],
      );
      expect(rows[0].ok, papel).toBe(false);
    }
  }, LENTO);
});
