// ============================================================================
// 094 — faturas dentro do protocolo de período
// ============================================================================
//
// Duas datas, e as duas contam: `invoice_date` é a emissão, `period_start` é o
// período facturado — e é por este que a fatura em rascunho bloqueia o fecho.
// Uma mutação que proteja uma e ignore a outra deixa metade do problema aberto.
//
// E `set_invoice_status_atomic` prova mais do que o período: a fatura e o
// movimento de caixa passam a ser uma escrita só.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `invper-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENTE_OUTRA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;
let mutationSequence = 0;

async function ligacao() {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

async function baseline() {
  await pool.query(`
    DROP EXTENSION IF EXISTS pgcrypto CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE EXTENSION pgcrypto;

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
    CREATE TABLE public._migrations (name text PRIMARY KEY);
    INSERT INTO public._migrations (name) VALUES ('077_secure_migrations_ledger.sql');
    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, actor_id uuid NOT NULL, action text NOT NULL,
      entity_type text NOT NULL DEFAULT 'timesheet', entity_id text,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, full_name text, role text NOT NULL DEFAULT 'gestor');
    CREATE TABLE public.clients (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
    CREATE TABLE public.services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid);
    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, transaction_date date
    );
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL DEFAULT 'pendente',
      period_year integer NOT NULL, period_month integer NOT NULL
    );

    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL DEFAULT CURRENT_DATE,
      due_date date, period_start date, period_end date,
      subtotal numeric(10,2) NOT NULL DEFAULT 0,
      vat_rate numeric(5,2) DEFAULT 23,
      vat_amount numeric(10,2) DEFAULT 0,
      total numeric(10,2) NOT NULL DEFAULT 0,
      status text DEFAULT 'rascunho'
        CHECK (status IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado')),
      paid_at timestamptz,
      payment_method text
        CHECK (payment_method IN ('transferencia','mbway','cheque','numerario','debito_direto','outro')),
      notes text,
      created_by uuid REFERENCES public.profiles(id),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      revision integer NOT NULL DEFAULT 1
    );

    CREATE TABLE public.invoice_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      service_id uuid REFERENCES public.services(id) ON DELETE SET NULL,
      description text NOT NULL,
      quantity numeric(10,2) NOT NULL DEFAULT 1,
      unit_price numeric(10,2) NOT NULL DEFAULT 0,
      total numeric(10,2) NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text, category text, date date NOT NULL,
      expense_category_id uuid, reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado',
      created_by uuid,
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX cash_flow_entries_reference_unique
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
    CREATE TABLE public.bank_reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
      bank_transaction_id uuid, cash_flow_entry_id uuid, status text NOT NULL DEFAULT 'suggested'
    );

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-094-invoice-rpc.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/078_domain_mutation_change_event_foundation.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/094_invoices_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name, role) VALUES ($1, $2, 'Gestora', 'gestor')", [
    ACTOR,
    EMPRESA,
  ]);
  await pool.query("INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Cliente')", [CLIENTE, EMPRESA]);
}

const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nFaturas = async () => Number((await pool.query("select count(*) n from public.invoices")).rows[0].n);
const nCaixa = async () => Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);
const nLinhas = async () => Number((await pool.query("select count(*) n from public.invoice_items")).rows[0].n);

const fatura = async (id: string) =>
  (
    await pool.query(
      `SELECT *, to_char(invoice_date,'YYYY-MM-DD') di, to_char(period_start,'YYYY-MM-DD') ps
         FROM public.invoices WHERE id = $1`,
      [id],
    )
  ).rows[0];

const movimento = async (id: string) =>
  (
    await pool.query(
      `SELECT *, to_char(date,'YYYY-MM-DD') d FROM public.cash_flow_entries
        WHERE reference_type = 'invoice' AND reference_id = $1`,
      [id],
    )
  ).rows[0];

const ITENS = JSON.stringify([{ description: "Limpeza", quantity: 1, unit_price: 100, total: 100, sort_order: 0 }]);

/** Cria uma fatura pela RPC, com emissão e período à escolha. */
async function criar(emissao: string, periodo: [string, string], total = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM public.create_invoice_with_items(
       $1, $2, 'F', 2026, $3::date, NULL, $4::date, $5::date, $6, 23, $7, $8, $9::jsonb)`,
    [EMPRESA, CLIENTE, emissao, periodo[0], periodo[1], total, 0, total, ITENS],
  );
  return rows[0].invoice_id as string;
}

/** Uma fatura semeada directamente, para preparar estados que a RPC não cria. */
async function semear(opts: {
  emissao: string;
  periodo?: [string, string];
  status?: string;
  total?: number;
  numero?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO public.invoices
       (company_id, client_id, invoice_number, invoice_date, period_start, period_end, total, status)
     VALUES ($1, $2, $3, $4::date, $5::date, $6::date, $7, $8) RETURNING id`,
    [
      EMPRESA,
      CLIENTE,
      opts.numero ?? `F2026/${Math.floor(Math.random() * 900 + 100)}`,
      opts.emissao,
      opts.periodo?.[0] ?? null,
      opts.periodo?.[1] ?? null,
      opts.total ?? 100,
      opts.status ?? "rascunho",
    ],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "invper",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB", "maintenance_work_mem=8MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
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
  mutationSequence = 0;
  await baseline();
});

function novaMutationId() {
  mutationSequence += 1;
  return `00000000-0000-4000-8000-${mutationSequence.toString(16).padStart(12, "0")}`;
}

async function mudarEstado(
  invoiceId: string,
  status: string,
  expectedRevision: number,
  paymentMethod: string | null = null,
  mutationId = novaMutationId(),
) {
  const { rows } = await pool.query(
    "SELECT public.set_invoice_status_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
    [invoiceId, EMPRESA, ACTOR, status, paymentMethod, mutationId, expectedRevision],
  );
  return rows[0].result as Record<string, unknown>;
}

describe("094 — CREATE: emissão e período facturado", () => {
  it("mês aberto: cria a fatura e as linhas, com o número da 072", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const f = await fatura(id);
    expect(f.invoice_number).toBe("F2026/001");
    expect(f.status).toBe("rascunho");
    expect(await nLinhas()).toBe(1);
  }, 120_000);

  it("🔴 mês da EMISSÃO fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 9);
    await expect(criar("2026-09-05", ["2026-07-01", "2026-07-31"])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-09/,
    );
    expect(await nFaturas()).toBe(0);
    expect(await nLinhas()).toBe(0);
  }, 120_000);

  it("🔴 mês do PERÍODO FACTURADO fechado: ZERO ESCRITA — a emissão não chega", async () => {
    // Este é o caso que a intuição perde. A fatura é emitida em Setembro, mas
    // cobra Julho — e é por Julho que ela conta como bloqueador do fecho. Gerar
    // uma fatura de Julho com Julho fechado acrescenta um rascunho a um mês
    // encerrado.
    await fechar(2026, 7);
    await expect(criar("2026-09-05", ["2026-07-01", "2026-07-31"])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-07/,
    );
    expect(await nFaturas()).toBe(0);
  }, 120_000);

  it("os dois meses ficam trancados, e um período sem datas usa só a emissão", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query(
      `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
         '2026-07-01'::date, '2026-07-31'::date, 100, 23, 0, 100, $3::jsonb)`,
      [EMPRESA, CLIENTE, ITENS],
    );
    const { rows } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 2 AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.chave))).toEqual([202607, 202609]);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("as guardas da 072 continuam lá: sem linhas não há fatura", async () => {
    await expect(
      pool.query(
        `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
           NULL, NULL, 0, 23, 0, 0, '[]'::jsonb)`,
        [EMPRESA, CLIENTE],
      ),
    ).rejects.toThrow(/sem linhas/);
    expect(await nFaturas()).toBe(0);
  }, 120_000);

  it("o lock do NÚMERO e o do PERÍODO são espaços diferentes", async () => {
    // A 072 usa a forma de UM argumento; o período usa a de dois. No PostgreSQL
    // nunca colidem, e é isso que permite manter os dois sem inventar uma chave
    // composta.
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query(
      `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
         '2026-09-01'::date, '2026-09-30'::date, 100, 23, 0, 100, $3::jsonb)`,
      [EMPRESA, CLIENTE, ITENS],
    );
    const { rows } = await c.query(
      `SELECT objsubid, count(*)::int n FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() GROUP BY objsubid ORDER BY objsubid`,
    );
    // 1 = forma de um argumento (número da fatura); 2 = forma de dois (período).
    expect(rows.map((r) => [r.objsubid, r.n])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("números sequenciais continuam a não colidir sob concorrência", async () => {
    const gerar = async () => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query(
          `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
             '2026-09-01'::date, '2026-09-30'::date, 100, 23, 0, 100, $3::jsonb)`,
          [EMPRESA, CLIENTE, ITENS],
        );
        await new Promise((r) => setTimeout(r, 120));
        await c.query("COMMIT");
        return rows[0].invoice_number as string;
      } finally {
        await c.end();
      }
    };
    const numeros = await Promise.all([gerar(), gerar(), gerar()]);
    expect(new Set(numeros).size).toBe(3);
  }, 120_000);
});

describe("094 — STATUS: a fatura e o caixa numa escrita só", () => {
  it("marcar como pago cria o movimento na mesma transação", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const result = await mudarEstado(id, "pago", 1, "transferencia");
    expect(result.ok).toBe(true);
    expect((result.cash_flow_entry as Record<string, unknown>).id).toBeTruthy();
    expect(result.event).toBeTruthy();
    expect((await pool.query("SELECT count(*)::int n FROM public.domain_mutations")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM public.company_change_events")).rows[0].n).toBe(1);

    const f = await fatura(id);
    expect(f.status).toBe("pago");
    expect(f.paid_at).toBeTruthy();
    expect(f.payment_method).toBe("transferencia");

    const m = await movimento(id);
    expect(m.type).toBe("entrada");
    expect(Number(m.amount)).toBe(100);
    expect(m.d).toBe(new Date().toISOString().slice(0, 10));
    expect(m.description).toContain("Cliente");
  }, 120_000);

  it("voltar atrás limpa o pagamento e remove o movimento", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    await mudarEstado(id, "pago", 1);
    const result = await mudarEstado(id, "pendente", 2);
    expect(result.ok).toBe(true);
    expect(result.cash_flow_entry).toBeNull();
    const f = await fatura(id);
    expect(f.status).toBe("pendente");
    expect(f.paid_at).toBeNull();
    expect(f.payment_method).toBeNull();
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("repetir «pago» não duplica o movimento nem reescreve `paid_at`", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const mutationId = novaMutationId();
    await mudarEstado(id, "pago", 1, null, mutationId);
    const primeiro = await fatura(id);
    const replay = await mudarEstado(id, "pago", 1, null, mutationId);
    expect(replay.replay).toBe(true);
    expect(await nCaixa()).toBe(1);
    expect((await fatura(id)).paid_at).toEqual(primeiro.paid_at);
    expect((await movimento(id)).d).toBe(new Date().toISOString().slice(0, 10));
  }, 120_000);

  it("recusa reutilizar a mesma mutation_id com outra intenção", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const mutationId = novaMutationId();
    await mudarEstado(id, "pago", 1, null, mutationId);
    const result = await mudarEstado(id, "pendente", 2, null, mutationId);
    expect(result).toMatchObject({ ok: false, code: "MUTATION_REUSE_CONFLICT" });
    expect((await fatura(id)).status).toBe("pago");
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("🔴 o mês do MOVIMENTO EXISTENTE é protegido ao voltar atrás — o quarto período", async () => {
    // O prestate pode conter um movimento legado numa data diferente da
    // emissão. A remoção tem de proteger também esse quarto período.
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    await pool.query(
      `UPDATE public.invoices
          SET status = 'pago', paid_at = '2026-10-05T12:00:00Z',
              payment_method = 'transferencia', revision = 2
        WHERE id = $1`,
      [id],
    );
    await pool.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, amount, description, category, date,
          reference_id, reference_type, status, created_by)
       VALUES ($1, 'entrada', 100, 'legado', 'faturacao', '2026-10-05',
          $2, 'invoice', 'confirmado', $3)`,
      [EMPRESA, id, ACTOR],
    );
    await fechar(2026, 10);

    await expect(mudarEstado(id, "pendente", 2)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-10/);

    expect(await nCaixa()).toBe(1);
    expect((await fatura(id)).status).toBe("pago");
  }, 120_000);

  it("🔴 o mês do PERÍODO FACTURADO fechado impede mudar o estado", async () => {
    const id = await criar("2026-09-05", ["2026-07-01", "2026-07-31"]);
    await fechar(2026, 7);
    await expect(mudarEstado(id, "pago", 1)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await fatura(id)).status).toBe("rascunho");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("revisão stale recusa antes de qualquer escrita de negócio", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const result = await mudarEstado(id, "pago", 99);
    expect(result).toMatchObject({ ok: false, code: "REVISION_CONFLICT", current_revision: 1 });
    expect((await fatura(id)).status).toBe("rascunho");
    expect((await fatura(id)).revision).toBe(1);
    expect(await nCaixa()).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM public.company_change_events")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM public.audit_logs")).rows[0].n).toBe(0);
  }, 120_000);

  it("recusa remover movimento reconciliado sem alterar fatura nem caixa", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    await mudarEstado(id, "pago", 1);
    const cash = await movimento(id);
    await pool.query(
      `INSERT INTO public.bank_reconciliation_matches
         (company_id, cash_flow_entry_id, status) VALUES ($1, $2, 'reconciled')`,
      [EMPRESA, cash.id],
    );

    const result = await mudarEstado(id, "pendente", 2);
    expect(result).toMatchObject({ ok: false, code: "RECONCILED_CASHFLOW" });
    expect((await fatura(id)).status).toBe("pago");
    expect(await nCaixa()).toBe(1);
  }, 120_000);

  it("falha depois do UPDATE faz rollback da fatura, caixa e recibo", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    await pool.query(`
      CREATE FUNCTION public.fail_invoice_cash_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_CASHFLOW_FAILURE'; END $$;
      CREATE TRIGGER fail_invoice_cash_insert
      BEFORE INSERT ON public.cash_flow_entries
      FOR EACH ROW EXECUTE FUNCTION public.fail_invoice_cash_insert();
    `);

    await expect(mudarEstado(id, "pago", 1)).rejects.toThrow(/INJECTED_CASHFLOW_FAILURE/);
    expect((await fatura(id)).status).toBe("rascunho");
    expect((await fatura(id)).revision).toBe(1);
    expect(await nCaixa()).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM public.domain_mutations")).rows[0].n).toBe(0);

    await pool.query("DROP TRIGGER fail_invoice_cash_insert ON public.cash_flow_entries");
    await pool.query("DROP FUNCTION public.fail_invoice_cash_insert()");
  }, 120_000);

  it("uma fatura a zero não gera movimento nenhum", async () => {
    const id = await semear({ emissao: "2026-09-05", periodo: ["2026-09-01", "2026-09-30"], total: 0 });
    const result = await mudarEstado(id, "pago", 1);
    expect(result.cash_flow_entry).toBeNull();
    expect((await fatura(id)).status).toBe("pago");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("recusa estados fora do CHECK da tabela, e fatura inexistente", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    expect(await mudarEstado(id, "inventado", 1)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await mudarEstado("77777777-7777-4777-8777-777777777777", "pago", 1)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  }, 120_000);

  it("não permite que um actor de uma empresa altere a fatura de outra", async () => {
    const id = (
      await pool.query(
        `INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Outro cliente') RETURNING id`,
        [CLIENTE_OUTRA, OUTRA],
      )
    ).rows[0].id;
    const { rows } = await pool.query(
      `INSERT INTO public.invoices
         (company_id, client_id, invoice_number, invoice_date, period_start, period_end, total)
       VALUES ($1, $2, 'B2026/001', '2026-09-05', '2026-09-01', '2026-09-30', 100)
       RETURNING id`,
      [OUTRA, id],
    );

    const result = (
      await pool.query(
        "SELECT public.set_invoice_status_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
        [rows[0].id, OUTRA, ACTOR, "pago", null, novaMutationId(), 1],
      )
    ).rows[0].result;
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN_ACTOR" });
    const other = await pool.query("SELECT status, revision FROM public.invoices WHERE id = $1", [rows[0].id]);
    expect(other.rows[0]).toEqual({ status: "rascunho", revision: 1 });
    expect(await nCaixa()).toBe(0);
  }, 120_000);
});

describe("094 — DELETE: só rascunhos", () => {
  it("mês aberto: apaga o rascunho e as suas linhas", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const { rows } = await pool.query("SELECT * FROM public.delete_invoice_atomic($1, $2, $3)", [EMPRESA, id, ACTOR]);
    expect(rows[0].apagados).toBe(1);
    expect(await nFaturas()).toBe(0);
    expect(await nLinhas()).toBe(0); // CASCADE
  }, 120_000);

  it("🔴 mês do PERÍODO FACTURADO fechado: ZERO ESCRITA", async () => {
    const id = await criar("2026-09-05", ["2026-07-01", "2026-07-31"]);
    await fechar(2026, 7);
    await expect(pool.query("SELECT * FROM public.delete_invoice_atomic($1, $2, $3)", [EMPRESA, id, ACTOR])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-07/,
    );
    expect(await nFaturas()).toBe(1);
  }, 120_000);

  it("uma fatura que já não é rascunho não se apaga", async () => {
    const id = await semear({ emissao: "2026-09-05", periodo: ["2026-09-01", "2026-09-30"], status: "pago" });
    await expect(pool.query("SELECT * FROM public.delete_invoice_atomic($1, $2, $3)", [EMPRESA, id, ACTOR])).rejects.toThrow(
      /INVOICE_NOT_DRAFT/,
    );
    expect(await nFaturas()).toBe(1);
  }, 120_000);

  it("apagar o que já não existe é sucesso, como na action", async () => {
    const { rows } = await pool.query("SELECT * FROM public.delete_invoice_atomic($1, $2, $3)", [
      EMPRESA,
      "77777777-7777-4777-8777-777777777777",
      ACTOR,
    ]);
    expect(rows[0].apagados).toBe(0);
  }, 120_000);
});

describe("094 — concorrência writer vs fecho", () => {
  it("writer primeiro: a fatura entra inteira, e o fecho vê o rascunho", async () => {
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    await writer.query(
      `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
         '2026-09-01'::date, '2026-09-30'::date, 100, 23, 0, 100, $3::jsonb)`,
      [EMPRESA, CLIENTE, ITENS],
    );

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nFaturas()).toBe(1);
    expect(r.rows[0].fechado).toBe(false);
    expect(r.rows[0].bloqueadores.faturas_rascunho).toBe(1);

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
          `SELECT * FROM public.create_invoice_with_items($1, $2, 'F', 2026, '2026-09-05'::date, NULL,
             '2026-09-01'::date, '2026-09-30'::date, 100, 23, 0, 100, $3::jsonb)`,
          [EMPRESA, CLIENTE, ITENS],
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
    expect(await nFaturas()).toBe(0);
    expect(await nLinhas()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("emissões e períodos cruzados em simultâneo: deadlock zero", async () => {
    const a = await semear({ emissao: "2026-07-05", periodo: ["2026-09-01", "2026-09-30"], numero: "F2026/900" });
    const b = await semear({ emissao: "2026-09-05", periodo: ["2026-07-01", "2026-07-31"], numero: "F2026/901" });

    const pagar = async (id: string, marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT public.set_invoice_status_atomic($1,$2,$3,'pago',NULL,$4,$5)",
          [id, EMPRESA, ACTOR, novaMutationId(), 1],
        );
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    expect(await Promise.all([pagar(a, "A"), pagar(b, "B")])).toEqual(["A", "B"]);
    expect(await nCaixa()).toBe(2);
  }, 120_000);

  it("duas mutações concorrentes da mesma fatura deixam uma só escrita", async () => {
    const id = await criar("2026-09-05", ["2026-09-01", "2026-09-30"]);
    const executar = async (mutationId: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query(
          "SELECT public.set_invoice_status_atomic($1,$2,$3,'pago',NULL,$4,1) AS result",
          [id, EMPRESA, ACTOR, mutationId],
        );
        await c.query("COMMIT");
        return rows[0].result as Record<string, unknown>;
      } finally {
        await c.end();
      }
    };

    const resultados = await Promise.all([
      executar("00000000-0000-4000-8000-000000000101"),
      executar("00000000-0000-4000-8000-000000000102"),
    ]);
    expect(resultados.filter((r) => r.ok === true)).toHaveLength(1);
    expect(resultados.filter((r) => r.code === "REVISION_CONFLICT")).toHaveLength(1);
    expect((await fatura(id)).status).toBe("pago");
    expect((await fatura(id)).revision).toBe(2);
    expect(await nCaixa()).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM public.company_change_events")).rows[0].n).toBe(1);
  }, 120_000);
});

describe("094 — superfície", () => {
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    [
      "create_invoice_with_items",
      "p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb",
    ],
    ["set_invoice_status_atomic", "p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text, p_payment_method text, p_mutation_id uuid, p_expected_revision integer"],
    ["delete_invoice_atomic", "p_company_id uuid, p_invoice_id uuid, p_actor uuid"],
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

  it("preserva SECURITY DEFINER apenas na RPC canónica e fecha o ACL público", async () => {
    const { rows: def } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND p.proname = ANY($1::text[])`,
      [ASSINATURAS.map(([n]) => n)],
    );
    expect(def.map((r) => r.proname)).toEqual(["set_invoice_status_atomic"]);

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

  it("adopta o prestate de produção de sete argumentos sem criar overload", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(
        p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text,
        p_payment_method text DEFAULT NULL, p_mutation_id uuid DEFAULT gen_random_uuid(),
        p_expected_revision integer DEFAULT NULL
      ) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS 'SELECT ''{}''::jsonb';
    `);

    const sql = readFileSync(join(ROOT, "supabase/migrations/094_invoices_period_atomic.sql"), "utf8");
    await pool.query(sql);
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
        WHERE n2.nspname = 'public' AND p.proname = 'set_invoice_status_atomic'`,
    );
    expect(rows[0].n).toBe(1);
    expect(await mudarEstado(await criar("2026-09-05", ["2026-09-01", "2026-09-30"]), "pago", 1)).toMatchObject({
      ok: true,
    });
  }, 120_000);

  it("recusa qualquer overload inesperado antes de tocar no domínio", async () => {
    await pool.query(`
      CREATE FUNCTION public.set_invoice_status_atomic(
        p_company_id uuid, p_invoice_id uuid, p_status text,
        p_paid_on date, p_payment_method text, p_actor uuid
      ) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS 'SELECT ''{}''::jsonb';
    `);

    const sql = readFileSync(join(ROOT, "supabase/migrations/094_invoices_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/094_UNEXPECTED_OVERLOAD/);
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
        WHERE n2.nspname = 'public' AND p.proname = 'set_invoice_status_atomic'`,
    );
    expect(rows[0].n).toBe(2);
  }, 120_000);

  it("a precondição recusa se a fundação 090 não estiver aplicada", async () => {
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_period_dates_open_locked(uuid, date[]) CASCADE");
    const sql = readFileSync(join(ROOT, "supabase/migrations/094_invoices_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/094_PRECONDITION_FAILED/);
  }, 120_000);
});
