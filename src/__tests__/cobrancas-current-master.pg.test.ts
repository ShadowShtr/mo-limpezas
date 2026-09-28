// ============================================================================
// Cobranças no master actual — as suposições das actions, contra PostgreSQL
// ============================================================================
//
// `manual-charges-period-atomic.pg.test.ts` e
// `service-payment-period-atomic.pg.test.ts` já provam as RPCs 091/097 por
// dentro (locks, deadlocks, N períodos). O que falta provar é o CONTRATO de que
// as actions novas dependem, com o SQL verdadeiro das migrations:
//
//   · a forma do retorno de cada RPC é a que os leitores de
//     `atomic-rpc-results.ts` aceitam — senão a action declara falha sobre uma
//     escrita que aconteceu, ou pior, sucesso sobre uma que não aconteceu;
//   · criar uma cobrança avulsa não cria serviço, fatura nem caixa;
//   · receber por 50 %, 100 %, valor livre e retirar — nos DOIS tipos — deixa
//     estado e caixa coerentes, e `cash_amount` diz o que ficou em caixa;
//   · editar valor com recebimento é recusado; anular com recebimento também;
//   · mês fechado recusa, mês aberto deixa;
//   · no fim, zero movimentos de caixa órfãos, das duas origens.
//
// As mensagens de recusa passam também pelo tradutor da interface: é a mesma
// string que a base levanta que tem de dar a frase certa no ecrã.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  readManualChargePaymentResult,
  readManualChargeResult,
  readServicePaymentResult,
} from "@/lib/atomic-rpc-results";
import { interpretBillingRefusal } from "@/domain/billing/billing-errors";

const ROOT = process.cwd();
const CONTAINER = `cobrcur-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const CLIENTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, period_start date
    );
    CREATE TABLE public.invoice_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid, service_id uuid
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
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, full_name text);
    CREATE TABLE public.clients (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
    CREATE TABLE public.company_settings (company_id uuid PRIMARY KEY, vat_rate numeric);
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
    CREATE TABLE public.manual_charges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
      charge_date date NOT NULL,
      description text NOT NULL,
      amount numeric(10,2) NOT NULL,
      apply_vat boolean NOT NULL DEFAULT true,
      payment_status text NOT NULL DEFAULT 'nao_informado'
        CHECK (payment_status IN ('nao_informado', 'sinal_50', 'pago_total')),
      paid_amount numeric(10,2), paid_at timestamptz,
      notes text,
      voided_at timestamptz,
      voided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT manual_charges_amount_positivo CHECK (amount > 0),
      CONSTRAINT manual_charges_void_coerente CHECK ((voided_at IS NULL) = (voided_by IS NULL))
    );

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  // O estado de produção antes de 090/091/097, e depois as três por cima — o
  // SQL real das migrations, não uma cópia.
  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/086-manual-charges-rpcs.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-097-service-payment-rpc.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/091_manual_charges_period_atomic.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/097_service_payment_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A')", [EMPRESA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [ACTOR, EMPRESA]);
  await pool.query("INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Cliente')", [CLIENTE, EMPRESA]);
  await pool.query("INSERT INTO public.company_settings (company_id, vat_rate) VALUES ($1, 23)", [EMPRESA]);
}

const fechar = (ano: number, mes: number) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [EMPRESA, ano, mes, ACTOR],
  );

async function mesDeHoje(): Promise<{ data: string; y: number; m: number }> {
  const { rows } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') data, EXTRACT(YEAR FROM d)::int y, EXTRACT(MONTH FROM d)::int m
       FROM (SELECT (now() AT TIME ZONE 'Europe/Lisbon')::date d) t`,
  );
  return rows[0];
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].n);

async function criar(data: string, amount = 100, iva = true) {
  const { rows } = await pool.query(
    "SELECT * FROM public.create_manual_charge_atomic($1, $2, $3::date, $4, $5, $6, $7, $8)",
    [EMPRESA, CLIENTE, data, "Limpeza extra", amount, iva, null, ACTOR],
  );
  const r = readManualChargeResult(rows);
  if (!r.ok) throw new Error(r.error);
  return r.chargeId;
}

const receberAvulsa = (id: string, status: string, valor: number | null = null) =>
  pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, $3, $4, $5)", [EMPRESA, id, status, valor, ACTOR]);

const receberServico = (id: string, status: string, valor: number | null = null) =>
  pool.query("SELECT * FROM public.set_service_payment_atomic($1, $2, $3, $4, $5)", [EMPRESA, id, status, valor, ACTOR]);

async function semearServico(data: string, valor = 100, iva = true) {
  const { rows } = await pool.query(
    `INSERT INTO public.services (company_id, reference_number, scheduled_start, manual_value, apply_vat)
     VALUES ($1, 'S-1', ($2::date + time '10:00') AT TIME ZONE 'Europe/Lisbon', $3, $4) RETURNING id`,
    [EMPRESA, data, valor, iva],
  );
  return rows[0].id as string;
}

async function recusa(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("esperava uma recusa da base");
}

/** Zero movimentos de caixa sem uma origem viva e com dinheiro. */
async function orfaos() {
  return {
    manual: await count(`
      SELECT count(*) n FROM public.cash_flow_entries c
       WHERE c.reference_type = 'manual_charge'
         AND NOT EXISTS (SELECT 1 FROM public.manual_charges m
                          WHERE m.id = c.reference_id AND m.voided_at IS NULL
                            AND m.payment_status <> 'nao_informado')`),
    servico: await count(`
      SELECT count(*) n FROM public.cash_flow_entries c
       WHERE c.reference_type = 'service_payment'
         AND NOT EXISTS (SELECT 1 FROM public.services s
                          WHERE s.id = c.reference_id AND s.payment_status <> 'nao_informado')`),
  };
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "cobrcur",
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

describe("cobrança avulsa — criar", () => {
  it("🔴 cria a nota e mais NADA: sem serviço, sem fatura, sem caixa", async () => {
    const { data } = await mesDeHoje();
    const id = await criar(data);
    expect(await count("SELECT count(*) n FROM public.manual_charges WHERE id = $1 AND payment_status = 'nao_informado'", [id])).toBe(1);
    expect(await count("SELECT count(*) n FROM public.services")).toBe(0);
    expect(await count("SELECT count(*) n FROM public.invoices")).toBe(0);
    expect(await count("SELECT count(*) n FROM public.invoice_items")).toBe(0);
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries")).toBe(0);
  });

  it("🔴 mês fechado: recusa, e a frase no ecrã é a do período", async () => {
    await fechar(2026, 3);
    const msg = await recusa(criar("2026-03-10"));
    expect(interpretBillingRefusal(msg)?.code).toBe("PERIOD_CLOSED");
    expect(await count("SELECT count(*) n FROM public.manual_charges")).toBe(0);
  });

  it("mês aberto ao lado de um fechado: deixa", async () => {
    await fechar(2026, 3);
    await expect(criar("2026-04-10")).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("cobrança avulsa — editar e anular", () => {
  it("edita sem recebimento; a resposta confirma a MESMA cobrança", async () => {
    const { data } = await mesDeHoje();
    const id = await criar(data);
    const { rows } = await pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
      EMPRESA, id, JSON.stringify({ amount: 80, description: "Vidros" }), ACTOR,
    ]);
    expect(readManualChargeResult(rows, id).ok).toBe(true);
    const { rows: [c] } = await pool.query("SELECT amount, description FROM public.manual_charges WHERE id = $1", [id]);
    expect(Number(c.amount)).toBe(80);
    expect(c.description).toBe("Vidros");
  });

  it("🔴 com recebimento, mudar o valor é recusado — e a frase diz porquê", async () => {
    const { data } = await mesDeHoje();
    const id = await criar(data);
    await receberAvulsa(id, "sinal_50");
    const msg = await recusa(pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
      EMPRESA, id, JSON.stringify({ amount: 10 }), ACTOR,
    ]));
    expect(interpretBillingRefusal(msg)?.code).toBe("AMOUNT_LOCKED");
  });

  it("anula sem recebimento; sai de tudo e não deixa caixa", async () => {
    const { data } = await mesDeHoje();
    const id = await criar(data);
    const { rows } = await pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]);
    expect(readManualChargeResult(rows, id).ok).toBe(true);
    expect(await count("SELECT count(*) n FROM public.manual_charges WHERE id = $1 AND voided_at IS NOT NULL", [id])).toBe(1);
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries")).toBe(0);
  });

  it("🔴 com recebimento, anular é recusado até o recebimento sair", async () => {
    const { data } = await mesDeHoje();
    const id = await criar(data);
    await receberAvulsa(id, "pago_total");
    const msg = await recusa(pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]));
    expect(interpretBillingRefusal(msg)?.code).toBe("HAS_PAYMENT");

    await receberAvulsa(id, "nao_informado");
    await pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]);
    expect(await orfaos()).toEqual({ manual: 0, servico: 0 });
  });
});

describe("recebimento — os quatro gestos, nos dois tipos", () => {
  // 100 € + 23 % = 123 €.
  const casos = [
    { gesto: "50%", status: "sinal_50", valor: null, caixa: 61.5 },
    { gesto: "100%", status: "pago_total", valor: null, caixa: 123 },
    { gesto: "valor livre", status: "sinal_50", valor: 40, caixa: 40 },
  ] as const;

  for (const c of casos) {
    it(`avulsa — ${c.gesto}: estado e caixa na mesma transação, cash_amount = ${c.caixa}`, async () => {
      const { data } = await mesDeHoje();
      const id = await criar(data);
      const { rows } = await receberAvulsa(id, c.status, c.valor);
      const r = readManualChargePaymentResult(rows, id);
      expect(r.ok && r.cashAmount).toBe(c.caixa);
      const { rows: [m] } = await pool.query(
        "SELECT amount FROM public.cash_flow_entries WHERE reference_type = 'manual_charge' AND reference_id = $1", [id]);
      expect(Number(m.amount)).toBe(c.caixa);
    });

    it(`serviço — ${c.gesto}: estado e caixa na mesma transação, cash_amount = ${c.caixa}`, async () => {
      const { data } = await mesDeHoje();
      const id = await semearServico(data);
      const { rows } = await receberServico(id, c.status, c.valor);
      const r = readServicePaymentResult(rows, id);
      expect(r.ok && r.cashAmount).toBe(c.caixa);
      const { rows: [m] } = await pool.query(
        "SELECT amount FROM public.cash_flow_entries WHERE reference_type = 'service_payment' AND reference_id = $1", [id]);
      expect(Number(m.amount)).toBe(c.caixa);
    });
  }

  it("retirar o recebimento desfaz os dois lados, nos dois tipos", async () => {
    const { data } = await mesDeHoje();
    const avulsa = await criar(data);
    const servico = await semearServico(data);
    await receberAvulsa(avulsa, "pago_total");
    await receberServico(servico, "pago_total");

    const a = readManualChargePaymentResult((await receberAvulsa(avulsa, "nao_informado")).rows, avulsa);
    const s = readServicePaymentResult((await receberServico(servico, "nao_informado")).rows, servico);
    expect(a.ok && a.cashAmount).toBe(0);
    expect(s.ok && s.cashAmount).toBe(0);
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries")).toBe(0);
    expect(await count("SELECT count(*) n FROM public.manual_charges WHERE paid_amount IS NULL AND paid_at IS NULL")).toBe(1);
  });

  it("🔴 mês do caixa (hoje) fechado: nenhum dos dois recebe, e nada muda", async () => {
    const hoje = await mesDeHoje();
    const avulsa = await criar(hoje.data);
    const servico = await semearServico(hoje.data);
    await fechar(hoje.y, hoje.m);
    expect(interpretBillingRefusal(await recusa(receberAvulsa(avulsa, "pago_total")))?.code).toBe("PERIOD_CLOSED");
    expect(interpretBillingRefusal(await recusa(receberServico(servico, "pago_total")))?.code).toBe("PERIOD_CLOSED");
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries")).toBe(0);
  });

  it("🔴 depois de tudo: zero movimentos órfãos, das duas origens", async () => {
    const { data } = await mesDeHoje();
    for (let i = 0; i < 3; i++) {
      const a = await criar(data, 50 + i);
      const s = await semearServico(data, 50 + i);
      await receberAvulsa(a, "pago_total");
      await receberServico(s, "sinal_50");
      await receberAvulsa(a, "sinal_50", 10);
      await receberServico(s, "nao_informado");
    }
    expect(await orfaos()).toEqual({ manual: 0, servico: 0 });
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries WHERE reference_type = 'service_payment'")).toBe(0);
    expect(await count("SELECT count(*) n FROM public.cash_flow_entries WHERE reference_type = 'manual_charge'")).toBe(3);
  });
});
