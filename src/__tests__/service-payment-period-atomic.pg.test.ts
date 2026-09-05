// ============================================================================
// 097 — pagamento de serviços dentro do protocolo de período
// ============================================================================
//
// A RPC da 086 já era atómica; o que lhe faltava era o período. Aqui prova-se
// que ganhou os TRÊS meses que a operação pode tocar — serviço, caixa antigo e
// hoje — e que tudo o resto ficou exactamente como estava.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `svcper-${process.pid}`;
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
    CREATE TABLE public.company_settings (company_id uuid PRIMARY KEY, vat_rate numeric);
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

    CREATE TABLE public.contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      fixed_monthly boolean DEFAULT false,
      fixed_price numeric(10,2),
      apply_vat boolean DEFAULT false
    );

    CREATE TABLE public.services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
      reference_number text,
      scheduled_start timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'concluido',
      manual_value numeric(10,2), calculated_value numeric(10,2),
      apply_vat boolean DEFAULT true,
      payment_status text NOT NULL DEFAULT 'nao_informado'
        CHECK (payment_status IN ('nao_informado', 'sinal_50', 'pago_total')),
      paid_amount numeric(10,2), paid_at timestamptz
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text, category text, date date NOT NULL,
      expense_category_id uuid, reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado',
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX cash_flow_ref_unico
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-097-service-payment-rpc.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/097_service_payment_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [
    ACTOR,
    EMPRESA,
  ]);
  await pool.query("INSERT INTO public.company_settings (company_id, vat_rate) VALUES ($1, 23)", [EMPRESA]);
}

const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nCaixa = async () => Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);
const servico = async (id: string) =>
  (await pool.query("SELECT * FROM public.services WHERE id = $1", [id])).rows[0];
const movimento = async (id: string) =>
  (
    await pool.query(
      `SELECT *, to_char(date,'YYYY-MM-DD') d FROM public.cash_flow_entries
        WHERE reference_type = 'service_payment' AND reference_id = $1`,
      [id],
    )
  ).rows[0];

/** O mês de hoje em Lisboa — é o que a RPC usa para o caixa. */
async function mesDeHoje(): Promise<[number, number]> {
  const { rows } = await pool.query(
    "SELECT EXTRACT(YEAR FROM d)::int y, EXTRACT(MONTH FROM d)::int m FROM (SELECT (now() AT TIME ZONE 'Europe/Lisbon')::date d) t",
  );
  return [rows[0].y, rows[0].m];
}

async function semearServico(data: string, opts?: { valor?: number; iva?: boolean }) {
  const { rows } = await pool.query(
    `INSERT INTO public.services (company_id, reference_number, scheduled_start, manual_value, apply_vat)
     VALUES ($1, 'S-001', ($2::date + time '10:00') AT TIME ZONE 'Europe/Lisbon', $3, $4) RETURNING id`,
    [EMPRESA, data, opts?.valor ?? 100, opts?.iva ?? false],
  );
  return rows[0].id as string;
}

const semearCaixa = (svcId: string, data: string, valor = 50) =>
  pool.query(
    `INSERT INTO public.cash_flow_entries
       (company_id, type, amount, description, category, date, reference_id, reference_type, status)
     VALUES ($1, 'entrada', $2, 'semeado', 'faturacao', $3::date, $4, 'service_payment', 'confirmado')`,
    [EMPRESA, valor, data, svcId],
  );

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "svcper",
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

describe("097 — o período do SERVIÇO", () => {
  it("mês aberto: serviço e caixa coerentes, na mesma transação", async () => {
    const id = await semearServico("2026-09-10", { valor: 100 });
    const { rows } = await pool.query(
      "SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)",
      [EMPRESA, id, ACTOR],
    );
    expect(Number(rows[0].cash_amount)).toBe(100);
    expect((await servico(id)).payment_status).toBe("pago_total");
    const m = await movimento(id);
    expect(m.type).toBe("entrada");
    expect(Number(m.amount)).toBe(100);
  }, 120_000);

  it("🔴 mês do SERVIÇO fechado: ZERO ESCRITA nos dois lados", async () => {
    const id = await semearServico("2026-01-10");
    await fechar(2026, 1);
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        id,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-01/);
    expect((await servico(id)).payment_status).toBe("nao_informado");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 mês do CAIXA (hoje) fechado: ZERO ESCRITA — a data do serviço não chega", async () => {
    const [ano, mes] = await mesDeHoje();
    const id = await semearServico("2026-01-10");
    await fechar(ano, mes);
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        id,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("os TRÊS meses ficam trancados quando há caixa antigo noutro mês", async () => {
    const [ano, mes] = await mesDeHoje();
    const id = await semearServico("2026-01-10");
    await semearCaixa(id, "2026-02-10");

    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      id,
      ACTOR,
    ]);
    const { rows } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.chave))).toEqual(
      [...new Set([202601, 202602, ano * 100 + mes])].sort((a, b) => a - b),
    );
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("🔴 o mês do CAIXA ANTIGO fechado: ZERO ESCRITA", async () => {
    const id = await semearServico("2026-01-10");
    await semearCaixa(id, "2026-02-10");
    await fechar(2026, 2);
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        id,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-02/);
    expect((await movimento(id)).d).toBe("2026-02-10");
    expect((await servico(id)).payment_status).toBe("nao_informado");
  }, 120_000);

  it("retirar o recebimento NÃO exige o mês corrente aberto", async () => {
    const [ano, mes] = await mesDeHoje();
    const id = await semearServico("2026-01-10");
    await semearCaixa(id, "2026-02-10");
    await pool.query(
      "UPDATE public.services SET payment_status = 'pago_total', paid_amount = 50, paid_at = now() WHERE id = $1",
      [id],
    );
    await fechar(ano, mes);

    await pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'nao_informado', NULL, $3)", [
      EMPRESA,
      id,
      ACTOR,
    ]);
    expect(await nCaixa()).toBe(0);
    const s = await servico(id);
    expect(s.payment_status).toBe("nao_informado");
    expect(s.paid_amount).toBeNull();
    expect(s.paid_at).toBeNull();
  }, 120_000);

  it("ordens de descoberta inversas em simultâneo: deadlock zero", async () => {
    const a = await semearServico("2026-01-10");
    await semearCaixa(a, "2026-02-10");
    const b = await semearServico("2026-02-15");
    await semearCaixa(b, "2026-01-05");

    const receber = async (id: string, marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
          EMPRESA,
          id,
          ACTOR,
        ]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    expect(await Promise.all([receber(a, "A"), receber(b, "B")])).toEqual(["A", "B"]);
    expect(await nCaixa()).toBe(2);
  }, 120_000);
});

describe("097 — a lógica da 086 fica intacta", () => {
  it("o IVA vem de `company_settings`", async () => {
    const id = await semearServico("2026-09-10", { valor: 100, iva: true });
    const { rows } = await pool.query(
      "SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)",
      [EMPRESA, id, ACTOR],
    );
    expect(Number(rows[0].cash_amount)).toBe(123);
  }, 120_000);

  it("`sinal_50` é metade", async () => {
    const id = await semearServico("2026-09-10", { valor: 100 });
    const { rows } = await pool.query(
      "SELECT * FROM public.set_service_payment_atomic($1, $2, 'sinal_50', NULL, $3)",
      [EMPRESA, id, ACTOR],
    );
    expect(Number(rows[0].cash_amount)).toBe(50);
  }, 120_000);

  it("a avença mensal divide o preço fixo pelos serviços do mês", async () => {
    const { rows: ct } = await pool.query(
      "INSERT INTO public.contracts (company_id, fixed_monthly, fixed_price, apply_vat) VALUES ($1, true, 300, false) RETURNING id",
      [EMPRESA],
    );
    const contrato = ct[0].id;
    const ids: string[] = [];
    for (let d = 1; d <= 3; d++) {
      const { rows } = await pool.query(
        `INSERT INTO public.services (company_id, contract_id, reference_number, scheduled_start, manual_value)
         VALUES ($1, $2, 'S', ('2026-09-0${d}'::date + time '10:00') AT TIME ZONE 'Europe/Lisbon', 999) RETURNING id`,
        [EMPRESA, contrato],
      );
      ids.push(rows[0].id);
    }
    const { rows } = await pool.query(
      "SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)",
      [EMPRESA, ids[0], ACTOR],
    );
    expect(Number(rows[0].cash_amount)).toBe(100); // 300 / 3
  }, 120_000);

  it("estado e valor incoerentes continuam a ser recusados", async () => {
    const id = await semearServico("2026-09-10", { valor: 100 });
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'nao_informado', 10, $3)", [
        EMPRESA,
        id,
        ACTOR,
      ]),
    ).rejects.toThrow(/STATUS_AMOUNT_INCOHERENT/);
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', 0, $3)", [EMPRESA, id, ACTOR]),
    ).rejects.toThrow(/STATUS_AMOUNT_INCOHERENT/);
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'inventado', NULL, $3)", [
        EMPRESA,
        id,
        ACTOR,
      ]),
    ).rejects.toThrow(/SERVICE_PAYMENT_STATUS_INVALID/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("um serviço sem valor não deixa marcar como recebido", async () => {
    const { rows: s } = await pool.query(
      `INSERT INTO public.services (company_id, reference_number, scheduled_start)
       VALUES ($1, 'S', ('2026-09-10'::date + time '10:00') AT TIME ZONE 'Europe/Lisbon') RETURNING id`,
      [EMPRESA],
    );
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        s[0].id,
        ACTOR,
      ]),
    ).rejects.toThrow(/sem valor a receber/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("repetir o mesmo recebimento é idempotente — nunca dois movimentos", async () => {
    const id = await semearServico("2026-09-10", { valor: 100 });
    await pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      id,
      ACTOR,
    ]);
    await pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      id,
      ACTOR,
    ]);
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("um serviço de outra empresa não é encontrado", async () => {
    await expect(
      pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        OUTRA,
        await semearServico("2026-09-10"),
        ACTOR,
      ]),
    ).rejects.toThrow(/SERVICE_NOT_FOUND/);
  }, 120_000);
});

describe("097 — concorrência writer vs fecho", () => {
  it("writer primeiro: o recebimento entra inteiro, e o fecho decide depois", async () => {
    const [ano, mes] = await mesDeHoje();
    const id = await semearServico(`${ano}-${String(mes).padStart(2, "0")}-10`, { valor: 100 });
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    await writer.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      id,
      ACTOR,
    ]);

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, $2, $3, $4)", [
      EMPRESA,
      ano,
      mes,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nCaixa()).toBe(1);
    // Uma ENTRADA não é bloqueador — só as saídas sem categoria o são.
    expect(r.rows[0].fechado).toBe(true);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const [ano, mes] = await mesDeHoje();
    const id = await semearServico(`${ano}-${String(mes).padStart(2, "0")}-10`, { valor: 100 });
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, $2, $3, $4)", [EMPRESA, ano, mes, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM public.set_service_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
          EMPRESA,
          id,
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
    expect((await servico(id)).payment_status).toBe("nao_informado");
    expect(await nCaixa()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);
});

describe("097 — superfície", () => {
  it("a assinatura da 086 fica EXACTAMENTE como estava", async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'set_service_payment_atomic'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].args).toBe(
      "p_company_id uuid, p_service_id uuid, p_status text, p_paid_amount numeric, p_actor uuid",
    );
    expect(rows[0].prosecdef).toBe(false);
  }, 120_000);

  it("anon e authenticated não executam; service_role executa", async () => {
    const alvo = "public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid)";
    for (const papel of ["anon", "authenticated", "public"]) {
      const { rows } = await pool.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS pode", [papel, alvo]);
      expect(rows[0].pode, `${papel} NÃO pode executar`).toBe(false);
    }
    const { rows } = await pool.query("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS pode", [alvo]);
    expect(rows[0].pode).toBe(true);
  }, 120_000);

  it("a precondição recusa se a fundação 090 não estiver aplicada", async () => {
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_period_dates_open_locked(uuid, date[]) CASCADE");
    const sql = readFileSync(join(ROOT, "supabase/migrations/097_service_payment_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/097_PRECONDITION_FAILED/);
  }, 120_000);
});
