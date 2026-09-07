// ============================================================================
// 091 — cobranças avulsas dentro do protocolo de período
// ============================================================================
//
// O que se exige de cada operação do ciclo de vida, com o mês fechado:
// ZERO ESCRITA. Não «erro tratado», não «escreve e avisa» — a linha não muda,
// e o movimento de caixa também não.
//
// E com o mês aberto: exactamente o comportamento que a 086 já tinha. Uma
// guarda que altera o negócio a que se cola não é uma guarda, é uma
// reescrita — e a 086 está em produção.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `mccperiod-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

async function ligacao() {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

/**
 * O palco mínimo: o que a 086 criou (reduzido ao que estas RPCs tocam) mais a
 * fundação da 090, e depois a 091 por cima.
 *
 * As tabelas são recriadas à mão em vez de correr a 086 inteira porque a 086
 * traz o domínio dos serviços e do calendário atrás dela. O que interessa
 * provar aqui é a guarda de período sobre estas quatro funções.
 */
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
    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, transaction_date date
    );
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL DEFAULT 'pendente',
      period_year integer NOT NULL, period_month integer NOT NULL
    );

    CREATE TABLE public.companies (
      id uuid PRIMARY KEY, name text NOT NULL
    );
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, company_id uuid, full_name text
    );
    CREATE TABLE public.clients (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL
    );
    CREATE TABLE public.company_settings (
      company_id uuid PRIMARY KEY, vat_rate numeric
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text, category text, date date NOT NULL,
      expense_category_id uuid,
      reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado'
    );
    -- O índice PARCIAL da 024, que o ON CONFLICT das RPCs precisa de inferir.
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
      CONSTRAINT manual_charges_paid_amount_nao_negativo
        CHECK (paid_amount IS NULL OR paid_amount >= 0),
      CONSTRAINT manual_charges_void_coerente
        CHECK ((voided_at IS NULL) = (voided_by IS NULL))
    );

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  // As RPCs da 086 que a 091 substitui — versão SEM guarda de período, tal
  // como estão em produção. É sobre estas que o CREATE OR REPLACE actua.
  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/086-manual-charges-rpcs.sql"), "utf8"));

  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/091_manual_charges_period_atomic.sql"), "utf8"));

  // Uma instrução por chamada: uma query com parâmetros não aceita várias
  // instruções («cannot insert multiple commands into a prepared statement»).
  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [
    ACTOR,
    EMPRESA,
  ]);
  await pool.query("INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Cliente')", [CLIENTE, EMPRESA]);
  await pool.query("INSERT INTO public.company_settings (company_id, vat_rate) VALUES ($1, 23)", [EMPRESA]);
}

const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query("SELECT * FROM public.close_financial_period_atomic($1, $2, $3, $4)", [empresa, ano, mes, ACTOR]);

const nCobrancas = async () =>
  Number((await pool.query("select count(*) n from public.manual_charges")).rows[0].n);

const nCaixa = async () =>
  Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);

/** Uma cobrança criada por baixo do protocolo, para preparar cenários. */
async function semearCobranca(data: string, opts?: { amount?: number }) {
  const { rows } = await pool.query(
    `INSERT INTO public.manual_charges (company_id, client_id, charge_date, description, amount)
     VALUES ($1, $2, $3::date, 'semeada', $4) RETURNING id`,
    [EMPRESA, CLIENTE, data, opts?.amount ?? 100],
  );
  return rows[0].id as string;
}

/** O mês de hoje em Lisboa — é o que a RPC de recebimento usa para o caixa. */
async function mesDeHoje(): Promise<[number, number]> {
  const { rows } = await pool.query(
    "SELECT EXTRACT(YEAR FROM d)::int y, EXTRACT(MONTH FROM d)::int m FROM (SELECT (now() AT TIME ZONE 'Europe/Lisbon')::date d) t",
  );
  return [rows[0].y, rows[0].m];
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "mccperiod",
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

describe("091 — CREATE", () => {
  it("mês aberto: cria", async () => {
    const { rows } = await pool.query(
      "SELECT * FROM public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'obra extra', 150, true, NULL, $3)",
      [EMPRESA, CLIENTE, ACTOR],
    );
    expect(rows[0].charge_id).toBeTruthy();
    expect(await nCobrancas()).toBe(1);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 9);

    await expect(
      pool.query(
        "SELECT * FROM public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'obra extra', 150, true, NULL, $3)",
        [EMPRESA, CLIENTE, ACTOR],
      ),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-09/);

    expect(await nCobrancas()).toBe(0);
  }, 120_000);

  it("o período é o da DATA DA COBRANÇA, não o de hoje", async () => {
    // Julho fechado, a cobrança é de Julho: recusa, mesmo lançada hoje.
    await fechar(2026, 7);
    await expect(
      pool.query(
        "SELECT * FROM public.create_manual_charge_atomic($1, $2, date '2026-07-15', 'retroactiva', 80, true, NULL, $3)",
        [EMPRESA, CLIENTE, ACTOR],
      ),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(await nCobrancas()).toBe(0);
  }, 120_000);

  it("valida os argumentos antes de tocar na base", async () => {
    for (const [sql, erro] of [
      ["SELECT public.create_manual_charge_atomic($1, $2, date '2026-09-10', '  ', 150, true, NULL, $3)", /DESCRIPTION_REQUIRED/],
      ["SELECT public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'x', 0, true, NULL, $3)", /AMOUNT_INVALID/],
      ["SELECT public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'x', -5, true, NULL, $3)", /AMOUNT_INVALID/],
    ] as const) {
      await expect(pool.query(sql, [EMPRESA, CLIENTE, ACTOR])).rejects.toThrow(erro);
    }
    expect(await nCobrancas()).toBe(0);
  }, 120_000);
});

describe("091 — UPDATE e movimento de data", () => {
  it("mês aberto: edita", async () => {
    const id = await semearCobranca("2026-09-10");
    await pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
      EMPRESA, id, JSON.stringify({ description: "nova descrição" }), ACTOR,
    ]);
    const { rows } = await pool.query("select description from public.manual_charges where id = $1", [id]);
    expect(rows[0].description).toBe("nova descrição");
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    const id = await semearCobranca("2026-09-10");
    await fechar(2026, 9);

    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ description: "não devia entrar" }), ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-09/);

    const { rows } = await pool.query("select description from public.manual_charges where id = $1", [id]);
    expect(rows[0].description).toBe("semeada");
  }, 120_000);

  it("🔴 date move com ORIGEM fechada: ZERO ESCRITA", async () => {
    const id = await semearCobranca("2026-07-10");
    await fechar(2026, 7);

    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ charge_date: "2026-08-10" }), ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);

    const { rows } = await pool.query("select to_char(charge_date, 'YYYY-MM-DD') d from public.manual_charges where id = $1", [id]);
    expect(rows[0].d).toBe("2026-07-10");
  }, 120_000);

  it("🔴 date move com DESTINO fechado: ZERO ESCRITA", async () => {
    const id = await semearCobranca("2026-07-10");
    await fechar(2026, 8);

    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ charge_date: "2026-08-10" }), ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);

    const { rows } = await pool.query("select to_char(charge_date, 'YYYY-MM-DD') d from public.manual_charges where id = $1", [id]);
    expect(rows[0].d).toBe("2026-07-10");
  }, 120_000);

  it("date move com os dois abertos: passa", async () => {
    const id = await semearCobranca("2026-07-10");
    await pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
      EMPRESA, id, JSON.stringify({ charge_date: "2026-08-10" }), ACTOR,
    ]);
    const { rows } = await pool.query("select to_char(charge_date, 'YYYY-MM-DD') d from public.manual_charges where id = $1", [id]);
    expect(rows[0].d).toBe("2026-08-10");
  }, 120_000);

  it("as guardas da 086 continuam todas lá", async () => {
    const id = await semearCobranca("2026-09-10");

    // Campo não editável.
    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ payment_status: "pago_total" }), ACTOR,
      ]),
    ).rejects.toThrow(/FIELD_NOT_EDITABLE/);

    // Valor bloqueado depois de haver dinheiro.
    await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA, id, ACTOR,
    ]);
    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ amount: 999 }), ACTOR,
      ]),
    ).rejects.toThrow(/PAID_AMOUNT_LOCKED/);

    // Cliente bloqueado depois de haver dinheiro.
    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA, id, JSON.stringify({ client_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), ACTOR,
      ]),
    ).rejects.toThrow(/CLIENT_LOCKED/);
  }, 120_000);
});

describe("091 — PAYMENT", () => {
  it("mês aberto: cobrança e caixa coerentes, na mesma transação", async () => {
    const id = await semearCobranca("2026-09-10", { amount: 100 });
    const { rows } = await pool.query(
      "SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)",
      [EMPRESA, id, ACTOR],
    );

    // 100 + 23% de IVA.
    expect(Number(rows[0].cash_amount)).toBe(123);
    expect(await nCaixa()).toBe(1);

    const { rows: caixa } = await pool.query("select * from public.cash_flow_entries");
    expect(caixa[0].reference_type).toBe("manual_charge");
    expect(caixa[0].reference_id).toBe(id);
    expect(Number(caixa[0].amount)).toBe(123);
  }, 120_000);

  it("🔴 mês da COBRANÇA fechado: ZERO ESCRITA nos dois lados", async () => {
    const id = await semearCobranca("2026-07-10");
    await fechar(2026, 7);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA, id, ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);

    const { rows } = await pool.query("select payment_status, paid_amount from public.manual_charges where id=$1", [id]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(rows[0].paid_amount).toBeNull();
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 mês do CAIXA (hoje) fechado: ZERO ESCRITA — payment date ≠ charge date", async () => {
    // A cobrança é de um mês aberto; o dinheiro entraria no mês de hoje, que
    // está fechado. Assumir que basta olhar para `charge_date` deixava passar.
    const id = await semearCobranca("2026-07-10");
    const [ano, mes] = await mesDeHoje();
    await fechar(ano, mes);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA, id, ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);

    const { rows } = await pool.query("select payment_status from public.manual_charges where id=$1", [id]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("retirar o recebimento desfaz os dois lados", async () => {
    const id = await semearCobranca("2026-09-10");
    await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA, id, ACTOR,
    ]);
    expect(await nCaixa()).toBe(1);

    await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'nao_informado', NULL, $3)", [
      EMPRESA, id, ACTOR,
    ]);

    const { rows } = await pool.query("select payment_status, paid_amount from public.manual_charges where id=$1", [id]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(rows[0].paid_amount).toBeNull();
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("repetir o mesmo recebimento é idempotente — nunca dois movimentos", async () => {
    const id = await semearCobranca("2026-09-10");
    for (let i = 0; i < 3; i += 1) {
      await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA, id, ACTOR,
      ]);
    }
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("🔴 falha a meio: nem cobrança nem caixa ficam alterados", async () => {
    const id = await semearCobranca("2026-09-10");
    const c = await ligacao();

    await c.query("BEGIN");
    await c.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA, id, ACTOR,
    ]);
    // A transação morre depois de as duas escritas terem acontecido.
    await c.query("ROLLBACK");
    await c.end();

    const { rows } = await pool.query("select payment_status from public.manual_charges where id=$1", [id]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("cobrança anulada não aceita recebimento", async () => {
    const id = await semearCobranca("2026-09-10");
    await pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA, id, ACTOR,
      ]),
    ).rejects.toThrow(/MANUAL_CHARGE_VOIDED/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);
});

describe("091 — VOID", () => {
  it("mês aberto: anula", async () => {
    const id = await semearCobranca("2026-09-10");
    await pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]);
    const { rows } = await pool.query("select voided_at, voided_by from public.manual_charges where id=$1", [id]);
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[0].voided_by).toBe(ACTOR);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    const id = await semearCobranca("2026-09-10");
    await fechar(2026, 9);

    await expect(
      pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-09/);

    const { rows } = await pool.query("select voided_at from public.manual_charges where id=$1", [id]);
    expect(rows[0].voided_at).toBeNull();
  }, 120_000);

  it("com recebimento continua a recusar, como na 086", async () => {
    const id = await semearCobranca("2026-09-10");
    await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA, id, ACTOR,
    ]);
    await expect(
      pool.query("SELECT * FROM public.void_manual_charge_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]),
    ).rejects.toThrow(/MANUAL_CHARGE_HAS_PAYMENT/);
  }, 120_000);
});

describe("091 — concorrência writer vs fecho", () => {
  it("writer primeiro: a cobrança entra inteira, e o fecho decide depois", async () => {
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    await writer.query(
      "SELECT * FROM public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'do writer', 50, true, NULL, $3)",
      [EMPRESA, CLIENTE, ACTOR],
    );

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA, ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nCobrancas()).toBe(1);
    // Nenhum dos quatro bloqueadores olha para manual_charges, por isso o mês
    // fecha — o que interessa é que fechou DEPOIS de ver a escrita, e não em
    // paralelo com ela.
    expect(r.rows[0].fechado).toBe(true);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      try {
        await writer.query(
          "SELECT * FROM public.create_manual_charge_atomic($1, $2, date '2026-09-10', 'tardia', 50, true, NULL, $3)",
          [EMPRESA, CLIENTE, ACTOR],
        );
        return "escreveu";
      } catch (erro) {
        return String((erro as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    await fecho.query("COMMIT");

    expect(await promessa).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    expect(await nCobrancas()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("empresas diferentes não competem", async () => {
    const a = await ligacao();
    await a.query("BEGIN");
    await a.query("SELECT public.lock_financial_period($1, 2026, 9)", [EMPRESA]);

    const b = await ligacao();
    const inicio = Date.now();
    await b.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [OUTRA]);
    expect(Date.now() - inicio).toBeLessThan(1000);

    await a.query("ROLLBACK");
    await a.end();
    await b.end();
  }, 120_000);
});

// ============================================================================
// TRÊS períodos numa operação — o caso que o par não cobria
// ============================================================================
//
// Receber uma cobrança que JÁ tem um movimento de caixa noutro mês toca em
// três meses de uma vez:
//
//   · o mês da cobrança;
//   · o mês do movimento que já lá está e vai ser reescrito;
//   · o mês de hoje, que é a data nova desse movimento.
//
// A versão anterior desta migration bloqueava dois e descobria o terceiro
// depois — dentro do ramo que remove o recebimento — e adquiria-o fora da
// ordem canónica. É esse o defeito que estes casos fixam.
describe("091 — N períodos numa só operação", () => {
  /** Um movimento de caixa já existente para a cobrança, com data à escolha. */
  const semearCaixa = (cobranca: string, data: string, valor = 50) =>
    pool.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, amount, description, category, date, reference_id, reference_type, status)
       VALUES ($1, 'entrada', $2, 'semeado', 'faturacao', $3::date, $4, 'manual_charge', 'confirmado')`,
      [EMPRESA, valor, data, cobranca],
    );

  const dataDoCaixa = async (cobranca: string) =>
    (
      await pool.query(
        `SELECT to_char(date, 'YYYY-MM-DD') d FROM public.cash_flow_entries
          WHERE reference_type = 'manual_charge' AND reference_id = $1`,
        [cobranca],
      )
    ).rows[0]?.d as string | undefined;

  it("receber uma cobrança com caixa NOUTRO mês protege os TRÊS meses", async () => {
    const [anoHoje, mesHoje] = await mesDeHoje();
    const cobranca = await semearCobranca("2026-01-15");
    await semearCaixa(cobranca, "2026-02-10");

    // Os três são distintos: Janeiro (cobrança), Fevereiro (caixa antigo) e o
    // mês corrente (data nova do movimento).
    expect([2026, 1]).not.toEqual([anoHoje, mesHoje]);
    expect([2026, 2]).not.toEqual([anoHoje, mesHoje]);

    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      cobranca,
      ACTOR,
    ]);

    // Enquanto a transação vive, NENHUM dos três fecha.
    const fechos = await Promise.all(
      ([[2026, 1], [2026, 2], [anoHoje, mesHoje]] as const).map(async ([ano, mes]) => {
        const f = await ligacao();
        return { f, p: f.query("SELECT * FROM public.close_financial_period_atomic($1, $2, $3, $4)", [EMPRESA, ano, mes, ACTOR]) };
      }),
    );
    await new Promise((r) => setTimeout(r, 400));

    const abertos = await pool.query(
      `SELECT count(*)::int n FROM public.financial_periods WHERE status = 'closed'`,
    );
    expect(abertos.rows[0].n).toBe(0);

    await c.query("COMMIT");
    await Promise.all(fechos.map(({ p }) => p.catch(() => null)));
    await Promise.all(fechos.map(({ f }) => f.end()));
    await c.end();
  }, 120_000);

  it("🔴 o mês do CAIXA ANTIGO fechado ⇒ ZERO ESCRITA nos dois lados", async () => {
    const cobranca = await semearCobranca("2026-01-15");
    await semearCaixa(cobranca, "2026-02-10");
    await fechar(2026, 2);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        cobranca,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-02/);

    // Nem a cobrança nem o movimento antigo mudaram.
    const { rows } = await pool.query("SELECT payment_status, paid_amount FROM public.manual_charges WHERE id = $1", [
      cobranca,
    ]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(rows[0].paid_amount).toBeNull();
    expect(await dataDoCaixa(cobranca)).toBe("2026-02-10");
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("🔴 RETIRAR o recebimento com o mês do movimento fechado ⇒ ZERO ESCRITA", async () => {
    const cobranca = await semearCobranca("2026-01-15");
    await semearCaixa(cobranca, "2026-02-10");
    await pool.query(
      "UPDATE public.manual_charges SET payment_status = 'pago_total', paid_amount = 50, paid_at = now() WHERE id = $1",
      [cobranca],
    );
    await fechar(2026, 2);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'nao_informado', NULL, $3)", [
        EMPRESA,
        cobranca,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-02/);

    expect(await nCaixa()).toBe(1);
    const { rows } = await pool.query("SELECT payment_status FROM public.manual_charges WHERE id = $1", [cobranca]);
    expect(rows[0].payment_status).toBe("pago_total");
  }, 120_000);

  it("retirar o recebimento NÃO exige o mês corrente aberto — nada é escrito com a data de hoje", async () => {
    // Uma correcção de um recebimento errado não pode ficar refém do fecho do
    // mês em que ela é feita: a operação só apaga movimentos com datas
    // próprias, e não escreve nada datado de hoje.
    const [anoHoje, mesHoje] = await mesDeHoje();
    const cobranca = await semearCobranca("2026-01-15");
    await semearCaixa(cobranca, "2026-02-10");
    await pool.query(
      "UPDATE public.manual_charges SET payment_status = 'pago_total', paid_amount = 50, paid_at = now() WHERE id = $1",
      [cobranca],
    );
    await fechar(anoHoje, mesHoje);

    await pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'nao_informado', NULL, $3)", [
      EMPRESA,
      cobranca,
      ACTOR,
    ]);

    expect(await nCaixa()).toBe(0);
    const { rows } = await pool.query("SELECT payment_status, paid_amount FROM public.manual_charges WHERE id = $1", [
      cobranca,
    ]);
    expect(rows[0].payment_status).toBe("nao_informado");
    expect(rows[0].paid_amount).toBeNull();
  }, 120_000);

  it("🔴 RECEBER com o mês corrente fechado continua a ser recusado", async () => {
    // A contrapartida do caso anterior: quando há dinheiro a entrar HOJE, o mês
    // de hoje é economicamente relevante e tem de estar aberto.
    const [anoHoje, mesHoje] = await mesDeHoje();
    const cobranca = await semearCobranca("2026-01-15");
    await fechar(anoHoje, mesHoje);

    await expect(
      pool.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
        EMPRESA,
        cobranca,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("ordens de descoberta inversas em simultâneo: deadlock zero", async () => {
    // Duas cobranças cujos conjuntos de períodos são o MESMO, mas descobertos
    // por ordens opostas: uma tem a cobrança em Janeiro e o caixa em Fevereiro,
    // a outra o inverso. Se a ordem de aquisição fosse a ordem de descoberta,
    // isto era um ciclo de espera.
    const c1 = await semearCobranca("2026-01-15");
    await semearCaixa(c1, "2026-02-10");
    const c2 = await semearCobranca("2026-02-15");
    await semearCaixa(c2, "2026-01-10");

    const receber = async (cobranca: string, marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
          EMPRESA,
          cobranca,
          ACTOR,
        ]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    const r = await Promise.all([receber(c1, "T1"), receber(c2, "T2")]);
    expect(r).toEqual(["T1", "T2"]);
    expect(await nCaixa()).toBe(2);
  }, 120_000);

  it("nenhum lock de período é adquirido depois da primeira escrita", async () => {
    // A prova estrutural do protocolo: quando a operação começa a escrever, o
    // conjunto de locks da transação já está completo. Se aparecesse um lock
    // novo a seguir, era o defeito de volta com outra roupa.
    const cobranca = await semearCobranca("2026-01-15");
    await semearCaixa(cobranca, "2026-02-10");

    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.set_manual_charge_payment_atomic($1, $2, 'pago_total', NULL, $3)", [
      EMPRESA,
      cobranca,
      ACTOR,
    ]);
    const [anoHoje, mesHoje] = await mesDeHoje();
    const { rows } = await c.query(
      `SELECT objid::bigint AS chave FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() ORDER BY objid`,
    );
    const chaves = rows.map((r) => Number(r.chave));
    expect(chaves).toEqual([...new Set([202601, 202602, anoHoje * 100 + mesHoje])].sort((a, b) => a - b));
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);
});

// ============================================================================
// Cross-company — o `service_role` passa por cima do RLS, esta guarda não
// ============================================================================
//
// Estas RPCs correm pelo `createAdminClient()`. Nenhuma política de RLS as
// trava. A pergunta «este cliente é desta empresa?» tem de ser respondida
// dentro da função, e é isso que se prova aqui.
describe("091 — CROSS_COMPANY_WRITE = 0", () => {
  const CLIENTE_ALHEIO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  beforeEach(async () => {
    await pool.query("INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Cliente de B')", [
      CLIENTE_ALHEIO,
      OUTRA,
    ]);
  });

  it("🔴 criar com cliente de OUTRA empresa é recusado, e não escreve nada", async () => {
    await expect(
      pool.query(
        "SELECT * FROM public.create_manual_charge_atomic($1, $2, '2026-09-10'::date, 'alheia', 100, true, NULL, $3)",
        [EMPRESA, CLIENTE_ALHEIO, ACTOR],
      ),
    ).rejects.toThrow(/MANUAL_CHARGE_CLIENT_FOREIGN/);

    expect(await nCobrancas()).toBe(0);
  }, 120_000);

  it("🔴 e recusa ANTES de tocar no período — a guarda não depende do mês", async () => {
    // Com o mês fechado a recusa viria de qualquer maneira. O que interessa é
    // que com o mês ABERTO também vem, e é esta a única razão pela qual vem.
    await expect(
      pool.query(
        "SELECT * FROM public.create_manual_charge_atomic($1, $2, '2026-09-10'::date, 'alheia', 100, true, NULL, $3)",
        [EMPRESA, CLIENTE_ALHEIO, ACTOR],
      ),
    ).rejects.toThrow(/MANUAL_CHARGE_CLIENT_FOREIGN/);
    expect(await nCobrancas()).toBe(0);
  }, 120_000);

  it("🔴 editar para um cliente de OUTRA empresa é recusado", async () => {
    const cobranca = await semearCobranca("2026-09-10");

    await expect(
      pool.query("SELECT * FROM public.update_manual_charge_atomic($1, $2, $3::jsonb, $4)", [
        EMPRESA,
        cobranca,
        JSON.stringify({ client_id: CLIENTE_ALHEIO }),
        ACTOR,
      ]),
    ).rejects.toThrow(/MANUAL_CHARGE_CLIENT_FOREIGN/);

    const { rows } = await pool.query("SELECT client_id FROM public.manual_charges WHERE id = $1", [cobranca]);
    expect(rows[0].client_id).toBe(CLIENTE);
  }, 120_000);

  it("um cliente inexistente é recusado pela mesma guarda, e não pela chave estrangeira", async () => {
    // A diferença importa: a FK dá um erro de constraint depois de a função ter
    // chegado ao INSERT. A guarda recusa antes, com nome próprio.
    await expect(
      pool.query(
        "SELECT * FROM public.create_manual_charge_atomic($1, $2, '2026-09-10'::date, 'fantasma', 100, true, NULL, $3)",
        [EMPRESA, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ACTOR],
      ),
    ).rejects.toThrow(/MANUAL_CHARGE_CLIENT_FOREIGN/);
    expect(await nCobrancas()).toBe(0);
  }, 120_000);

  it("o cliente da própria empresa continua a passar", async () => {
    await pool.query(
      "SELECT * FROM public.create_manual_charge_atomic($1, $2, '2026-09-10'::date, 'legítima', 100, true, NULL, $3)",
      [EMPRESA, CLIENTE, ACTOR],
    );
    expect(await nCobrancas()).toBe(1);
  }, 120_000);
});

describe("091 — superfície", () => {
  const FUNCOES: ReadonlyArray<readonly [string, string]> = [
    ["create_manual_charge_atomic", "uuid, uuid, date, text, numeric, boolean, text, uuid"],
    ["update_manual_charge_atomic", "uuid, uuid, jsonb, uuid"],
    ["set_manual_charge_payment_atomic", "uuid, uuid, text, numeric, uuid"],
    ["void_manual_charge_atomic", "uuid, uuid, uuid"],
  ];

  it("nenhuma é SECURITY DEFINER", async () => {
    const { rows } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef AND p.proname = ANY($1::text[])`,
      [FUNCOES.map(([n]) => n)],
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  }, 120_000);

  it("anon e authenticated não executam; service_role executa", async () => {
    for (const [nome, tipos] of FUNCOES) {
      const alvo = `public.${nome}(${tipos})`;
      for (const papel of ["anon", "authenticated", "public"]) {
        const { rows } = await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') pode", [papel, alvo]);
        expect(rows[0].pode, `${papel} não executa ${nome}`).toBe(false);
      }
      const { rows } = await pool.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') pode", [alvo]);
      expect(rows[0].pode, `service_role executa ${nome}`).toBe(true);
    }
  }, 120_000);

  it("a precondição recusa se a fundação 090 não estiver aplicada", async () => {
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_periods_open_locked_pair(uuid,integer,integer,integer,integer)");
    const sql = readFileSync(join(ROOT, "supabase/migrations/091_manual_charges_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/091_PRECONDITION_FAILED/);
  }, 120_000);
});
