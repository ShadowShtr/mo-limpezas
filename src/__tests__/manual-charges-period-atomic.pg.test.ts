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
