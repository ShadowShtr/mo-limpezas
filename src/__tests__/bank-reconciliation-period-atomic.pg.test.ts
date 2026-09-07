// ============================================================================
// 095 — conciliação bancária dentro do protocolo de período
// ============================================================================
//
// O critério que faltava: `bank_transactions.status = 'pending'` é um dos
// quatro bloqueadores do fecho. Mudar esse estado não move dinheiro, mas move a
// resposta à pergunta «este mês pode fechar?» — e isso é efeito económico sobre
// o período.
//
// E `deleteImport` é o writer sem número fixo de períodos: um extracto
// atravessa meses, e a cascata leva-os todos de uma vez.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `bankper-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMPORTACAO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
      status text NOT NULL DEFAULT 'confirmado', notes text,
      created_by uuid, created_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.bank_statement_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      file_name text NOT NULL, file_type text NOT NULL, file_hash text NOT NULL,
      status text NOT NULL DEFAULT 'completed',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      statement_import_id uuid REFERENCES public.bank_statement_imports(id) ON DELETE CASCADE,
      transaction_date date NOT NULL,
      description text NOT NULL DEFAULT '',
      amount numeric(12,2) NOT NULL,
      direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
      fingerprint text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'matched', 'reconciled', 'ignored', 'duplicate')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.bank_reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
      cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
      match_score integer NOT NULL DEFAULT 0,
      match_reason text,
      status text NOT NULL DEFAULT 'suggested'
        CHECK (status IN ('suggested', 'confirmed', 'rejected')),
      confirmed_by uuid, confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_bank_match_pair
      ON public.bank_reconciliation_matches (bank_transaction_id, cash_flow_entry_id);

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-095-bank-rpc.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/095_bank_reconciliation_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [
    ACTOR,
    EMPRESA,
  ]);
  await pool.query(
    "INSERT INTO public.bank_statement_imports (id, company_id, file_name, file_type, file_hash) VALUES ($1, $2, 'extracto.csv', 'csv', 'h')",
    [IMPORTACAO, EMPRESA],
  );
}

const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nCaixa = async () => Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);
const nTx = async () => Number((await pool.query("select count(*) n from public.bank_transactions")).rows[0].n);
const nMatches = async () =>
  Number((await pool.query("select count(*) n from public.bank_reconciliation_matches")).rows[0].n);

const transacao = async (id: string) =>
  (await pool.query("SELECT * FROM public.bank_transactions WHERE id = $1", [id])).rows[0];
const correspondencia = async (id: string) =>
  (await pool.query("SELECT * FROM public.bank_reconciliation_matches WHERE id = $1", [id])).rows[0];

async function semearTx(data: string, opts?: { estado?: string; direction?: string; importacao?: string | null }) {
  const { rows } = await pool.query(
    `INSERT INTO public.bank_transactions
       (company_id, statement_import_id, transaction_date, description, amount, direction, status)
     VALUES ($1, $2, $3::date, 'Transferência', 100, $4, $5) RETURNING id`,
    [
      EMPRESA,
      opts?.importacao === null ? null : (opts?.importacao ?? IMPORTACAO),
      data,
      opts?.direction ?? "debit",
      opts?.estado ?? "pending",
    ],
  );
  return rows[0].id as string;
}

async function semearCaixa(data: string, empresa = EMPRESA) {
  const { rows } = await pool.query(
    `INSERT INTO public.cash_flow_entries (company_id, type, amount, description, category, date)
     VALUES ($1, 'saida', 100, 'movimento', 'despesa', $2::date) RETURNING id`,
    [empresa, data],
  );
  return rows[0].id as string;
}

async function semearMatch(txId: string, entryId: string | null, estado = "suggested") {
  const { rows } = await pool.query(
    `INSERT INTO public.bank_reconciliation_matches
       (company_id, bank_transaction_id, cash_flow_entry_id, match_score, status)
     VALUES ($1, $2, $3, 80, $4) RETURNING id`,
    [EMPRESA, txId, entryId, estado],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "bankper",
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

describe("095 — CONFIRM", () => {
  it("mês aberto: confirma, rejeita as outras e reconcilia a transacção", async () => {
    const tx = await semearTx("2026-07-10");
    const mov = await semearCaixa("2026-07-10");
    const m1 = await semearMatch(tx, mov);
    const m2 = await semearMatch(tx, await semearCaixa("2026-07-11"));

    const { rows } = await pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [
      EMPRESA,
      m1,
      ACTOR,
    ]);
    expect(rows[0].rejeitadas).toBe(1);
    expect((await correspondencia(m1)).status).toBe("confirmed");
    expect((await correspondencia(m2)).status).toBe("rejected");
    expect((await transacao(tx)).status).toBe("reconciled");
  }, 120_000);

  it("🔴 mês da TRANSACÇÃO fechado: ZERO ESCRITA", async () => {
    const tx = await semearTx("2026-07-10");
    const m = await semearMatch(tx, await semearCaixa("2026-07-10"));
    await fechar(2026, 7);

    await expect(
      pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [EMPRESA, m, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await transacao(tx)).status).toBe("pending");
    expect((await correspondencia(m)).status).toBe("suggested");
  }, 120_000);

  it("🔴 mês do MOVIMENTO DE CAIXA fechado: ZERO ESCRITA — conciliar congela-o", async () => {
    // A partir da confirmação, o movimento fica conciliado e a 081 recusa
    // desmarcá-lo. Conciliar um movimento de um mês fechado é congelá-lo por
    // uma via lateral.
    const tx = await semearTx("2026-09-10");
    const m = await semearMatch(tx, await semearCaixa("2026-05-10"));
    await fechar(2026, 5);

    await expect(
      pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [EMPRESA, m, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-05/);
    expect((await transacao(tx)).status).toBe("pending");
  }, 120_000);

  it("as guardas da 082 continuam todas lá", async () => {
    const tx = await semearTx("2026-07-10");
    const m1 = await semearMatch(tx, await semearCaixa("2026-07-10"), "confirmed");
    const m2 = await semearMatch(tx, await semearCaixa("2026-07-11"));
    await expect(
      pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [EMPRESA, m2, ACTOR]),
    ).rejects.toThrow(/BANK_TRANSACTION_ALREADY_RECONCILED/);
    expect((await correspondencia(m1)).status).toBe("confirmed");

    const tx2 = await semearTx("2026-07-10");
    const m3 = await semearMatch(tx2, await semearCaixa("2026-07-10"), "rejected");
    await expect(
      pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [EMPRESA, m3, ACTOR]),
    ).rejects.toThrow(/BANK_MATCH_REJECTED/);

    await expect(
      pool.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [
        EMPRESA,
        "77777777-7777-4777-8777-777777777777",
        ACTOR,
      ]),
    ).rejects.toThrow(/BANK_MATCH_NOT_FOUND/);
  }, 120_000);

  it("duas confirmações da mesma transacção em simultâneo: uma só vence", async () => {
    const tx = await semearTx("2026-07-10");
    const m1 = await semearMatch(tx, await semearCaixa("2026-07-10"));
    const m2 = await semearMatch(tx, await semearCaixa("2026-07-11"));

    const confirmar = async (m: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.confirm_bank_match_atomic($1, $2, $3)", [EMPRESA, m, ACTOR]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return "ok";
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        return String((e as Error).message);
      } finally {
        await c.end();
      }
    };

    const r = await Promise.all([confirmar(m1), confirmar(m2)]);
    expect(r.filter((x) => x === "ok")).toHaveLength(1);
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM public.bank_reconciliation_matches WHERE status = 'confirmed'",
    );
    expect(rows[0].n).toBe(1);
  }, 120_000);
});

describe("095 — REJECT: a operação que ACRESCENTA um bloqueador", () => {
  it("rejeita e devolve a transacção a pendente quando fica sem sugestões", async () => {
    const tx = await semearTx("2026-07-10", { estado: "matched" });
    const m = await semearMatch(tx, await semearCaixa("2026-07-10"));

    const { rows } = await pool.query("SELECT * FROM public.reject_bank_match_atomic($1, $2, $3)", [EMPRESA, m, ACTOR]);
    expect(rows[0].voltou_a_pendente).toBe(true);
    expect((await correspondencia(m)).status).toBe("rejected");
    expect((await transacao(tx)).status).toBe("pending");
  }, 120_000);

  it("não devolve a pendente se ainda houver outra sugestão activa", async () => {
    const tx = await semearTx("2026-07-10", { estado: "matched" });
    const m1 = await semearMatch(tx, await semearCaixa("2026-07-10"));
    await semearMatch(tx, await semearCaixa("2026-07-11"));

    const { rows } = await pool.query("SELECT * FROM public.reject_bank_match_atomic($1, $2, $3)", [
      EMPRESA,
      m1,
      ACTOR,
    ]);
    expect(rows[0].voltou_a_pendente).toBe(false);
    expect((await transacao(tx)).status).toBe("matched");
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA — devolver a `pending` é acrescentar um bloqueador", async () => {
    const tx = await semearTx("2026-07-10", { estado: "matched" });
    const m = await semearMatch(tx, await semearCaixa("2026-07-10"));
    await fechar(2026, 7);

    await expect(
      pool.query("SELECT * FROM public.reject_bank_match_atomic($1, $2, $3)", [EMPRESA, m, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await correspondencia(m)).status).toBe("suggested");
    expect((await transacao(tx)).status).toBe("matched");
  }, 120_000);
});

describe("095 — MANUAL MATCH", () => {
  it("mês aberto: associa, rejeita as outras e reconcilia", async () => {
    const tx = await semearTx("2026-07-10");
    const mov = await semearCaixa("2026-07-10");
    const outra = await semearMatch(tx, await semearCaixa("2026-07-11"));

    const { rows } = await pool.query("SELECT * FROM public.manual_bank_match_atomic($1, $2, $3, $4)", [
      EMPRESA,
      tx,
      mov,
      ACTOR,
    ]);
    expect(rows[0].rejeitadas).toBe(1);
    expect((await correspondencia(outra)).status).toBe("rejected");
    expect((await transacao(tx)).status).toBe("reconciled");
  }, 120_000);

  it("repetir a mesma associação é idempotente", async () => {
    const tx = await semearTx("2026-07-10");
    const mov = await semearCaixa("2026-07-10");
    await pool.query("SELECT * FROM public.manual_bank_match_atomic($1, $2, $3, $4)", [EMPRESA, tx, mov, ACTOR]);
    await pool.query("SELECT * FROM public.manual_bank_match_atomic($1, $2, $3, $4)", [EMPRESA, tx, mov, ACTOR]);
    expect(await nMatches()).toBe(1);
  }, 120_000);

  it("🔴 CROSS_COMPANY: o movimento de outra empresa é recusado", async () => {
    // Estas RPCs correm pelo `service_role`, que passa por cima do RLS.
    const tx = await semearTx("2026-07-10");
    const alheio = await semearCaixa("2026-07-10", OUTRA);
    await expect(
      pool.query("SELECT * FROM public.manual_bank_match_atomic($1, $2, $3, $4)", [EMPRESA, tx, alheio, ACTOR]),
    ).rejects.toThrow(/CASHFLOW_NOT_FOUND/);
    expect(await nMatches()).toBe(0);
    expect((await transacao(tx)).status).toBe("pending");
  }, 120_000);

  it("🔴 qualquer um dos dois meses fechado: ZERO ESCRITA", async () => {
    for (const [mesFechado, esperado] of [
      [7, /2026-07/],
      [5, /2026-05/],
    ] as const) {
      await baseline();
      const tx = await semearTx("2026-07-10");
      const mov = await semearCaixa("2026-05-10");
      await fechar(2026, mesFechado);
      await expect(
        pool.query("SELECT * FROM public.manual_bank_match_atomic($1, $2, $3, $4)", [EMPRESA, tx, mov, ACTOR]),
      ).rejects.toThrow(esperado);
      expect(await nMatches()).toBe(0);
      expect((await transacao(tx)).status).toBe("pending");
    }
  }, 180_000);
});

describe("095 — IGNORAR", () => {
  it("ignorar e voltar atrás, com o mês aberto", async () => {
    const tx = await semearTx("2026-07-10");
    await pool.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, true, $3)", [EMPRESA, tx, ACTOR]);
    expect((await transacao(tx)).status).toBe("ignored");
    await pool.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, false, $3)", [
      EMPRESA,
      tx,
      ACTOR,
    ]);
    expect((await transacao(tx)).status).toBe("pending");
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA nos dois sentidos", async () => {
    const tx = await semearTx("2026-07-10");
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, true, $3)", [EMPRESA, tx, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await transacao(tx)).status).toBe("pending");

    const tx2 = await semearTx("2026-07-11", { estado: "ignored" });
    await expect(
      pool.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, false, $3)", [EMPRESA, tx2, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await transacao(tx2)).status).toBe("ignored");
  }, 120_000);

  it("uma transacção já conciliada não se ignora", async () => {
    const tx = await semearTx("2026-07-10", { estado: "reconciled" });
    await expect(
      pool.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, true, $3)", [EMPRESA, tx, ACTOR]),
    ).rejects.toThrow(/BANK_TRANSACTION_ALREADY_RECONCILED/);
  }, 120_000);
});

describe("095 — CRIAR LANÇAMENTO A PARTIR DA TRANSACÇÃO", () => {
  it("mês aberto: cria o movimento, a correspondência e reconcilia, numa transação", async () => {
    const tx = await semearTx("2026-07-10", { direction: "credit" });
    const { rows } = await pool.query(
      "SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, NULL, $3)",
      [EMPRESA, tx, ACTOR],
    );
    expect(rows[0].entry_id).toBeTruthy();
    expect(rows[0].match_id).toBeTruthy();

    const { rows: mov } = await pool.query(
      "SELECT *, to_char(date,'YYYY-MM-DD') d FROM public.cash_flow_entries WHERE id = $1",
      [rows[0].entry_id],
    );
    expect(mov[0].type).toBe("entrada");
    expect(mov[0].category).toBe("faturacao");
    expect(mov[0].d).toBe("2026-07-10");
    expect((await transacao(tx)).status).toBe("reconciled");
  }, 120_000);

  it("um débito dá saída/despesa, e a categoria pode ser imposta", async () => {
    const tx = await semearTx("2026-07-10", { direction: "debit" });
    const { rows } = await pool.query(
      "SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, 'fornecedor', $3)",
      [EMPRESA, tx, ACTOR],
    );
    const { rows: mov } = await pool.query("SELECT * FROM public.cash_flow_entries WHERE id = $1", [rows[0].entry_id]);
    expect(mov[0].type).toBe("saida");
    expect(mov[0].category).toBe("fornecedor");
  }, 120_000);

  it("uma descrição vazia não gera um movimento sem nome", async () => {
    const { rows: t } = await pool.query(
      `INSERT INTO public.bank_transactions
         (company_id, statement_import_id, transaction_date, description, amount, direction)
       VALUES ($1, $2, '2026-07-10'::date, '   ', 50, 'debit') RETURNING id`,
      [EMPRESA, IMPORTACAO],
    );
    const { rows } = await pool.query(
      "SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, NULL, $3)",
      [EMPRESA, t[0].id, ACTOR],
    );
    const { rows: mov } = await pool.query("SELECT description FROM public.cash_flow_entries WHERE id = $1", [
      rows[0].entry_id,
    ]);
    expect(mov[0].description).toBe("Movimento bancário");
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA nos TRÊS lados", async () => {
    const tx = await semearTx("2026-07-10");
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, NULL, $3)", [
        EMPRESA,
        tx,
        ACTOR,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(await nCaixa()).toBe(0);
    expect(await nMatches()).toBe(0);
    expect((await transacao(tx)).status).toBe("pending");
  }, 120_000);

  it("uma transacção já conciliada não gera um segundo lançamento", async () => {
    const tx = await semearTx("2026-07-10", { estado: "reconciled" });
    await expect(
      pool.query("SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, NULL, $3)", [
        EMPRESA,
        tx,
        ACTOR,
      ]),
    ).rejects.toThrow(/BANK_TRANSACTION_ALREADY_RECONCILED/);
    expect(await nCaixa()).toBe(0);
  }, 120_000);
});

describe("095 — APAGAR IMPORTAÇÃO: N períodos", () => {
  it("um extracto de três meses tranca os TRÊS", async () => {
    await semearTx("2026-05-10");
    await semearTx("2026-06-15");
    await semearTx("2026-07-20");
    await semearTx("2026-07-25"); // mesmo mês: um lock lógico só

    const c = await ligacao();
    await c.query("BEGIN");
    const { rows } = await c.query("SELECT * FROM public.delete_bank_import_atomic($1, $2, $3)", [
      EMPRESA,
      IMPORTACAO,
      ACTOR,
    ]);
    expect(rows[0].periodos).toEqual([202605, 202606, 202607]);

    const { rows: locks } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 2 AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(locks.map((r) => Number(r.chave))).toEqual([202605, 202606, 202607]);
    await c.query("COMMIT");
    await c.end();

    expect(await nTx()).toBe(0);
  }, 120_000);

  it("🔴 QUALQUER um dos meses fechado: ZERO ESCRITA", async () => {
    for (const mes of [5, 6, 7]) {
      await baseline();
      await semearTx("2026-05-10");
      await semearTx("2026-06-15");
      await semearTx("2026-07-20");
      await fechar(2026, mes);

      await expect(
        pool.query("SELECT * FROM public.delete_bank_import_atomic($1, $2, $3)", [EMPRESA, IMPORTACAO, ACTOR]),
        `mês ${mes}`,
      ).rejects.toThrow(new RegExp(`FINANCIAL_PERIOD_CLOSED: 2026-0${mes}`));
      expect(await nTx()).toBe(3);
    }
  }, 180_000);

  it("os movimentos de caixa criados a partir do extracto NÃO são apagados", async () => {
    const tx = await semearTx("2026-07-10");
    await pool.query("SELECT * FROM public.create_cashflow_from_bank_transaction_atomic($1, $2, NULL, $3)", [
      EMPRESA,
      tx,
      ACTOR,
    ]);
    expect(await nCaixa()).toBe(1);

    await pool.query("SELECT * FROM public.delete_bank_import_atomic($1, $2, $3)", [EMPRESA, IMPORTACAO, ACTOR]);

    expect(await nTx()).toBe(0);
    expect(await nMatches()).toBe(0); // cascata da transacção
    expect(await nCaixa()).toBe(1); // o dinheiro fica
  }, 120_000);

  it("uma importação vazia não toca período nenhum, e apaga na mesma", async () => {
    // Nem é o conjunto vazio proibido da 090 — é a ausência de efeito
    // económico, e a distinção está explícita na função.
    await fechar(2026, 7);
    const { rows } = await pool.query("SELECT * FROM public.delete_bank_import_atomic($1, $2, $3)", [
      EMPRESA,
      IMPORTACAO,
      ACTOR,
    ]);
    expect(rows[0].apagados).toBe(1);
    expect(rows[0].periodos).toEqual([]);
  }, 120_000);

  it("apagar o que já não existe é sucesso, como na action", async () => {
    const { rows } = await pool.query("SELECT * FROM public.delete_bank_import_atomic($1, $2, $3)", [
      EMPRESA,
      "66666666-6666-4666-8666-666666666666",
      ACTOR,
    ]);
    expect(rows[0].apagados).toBe(0);
  }, 120_000);
});

describe("095 — concorrência writer vs fecho", () => {
  it("writer primeiro: o fecho vê o pendente que ainda lá está", async () => {
    await semearTx("2026-09-10");
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    const tx2 = await semearTx("2026-09-11");
    await writer.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, true, $3)", [
      EMPRESA,
      tx2,
      ACTOR,
    ]);

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    // Um foi ignorado, o outro continua pendente — e é o que o fecho conta.
    expect(r.rows[0].fechado).toBe(false);
    expect(r.rows[0].bloqueadores.movimentos_por_conciliar).toBe(1);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const tx = await semearTx("2026-09-10", { estado: "ignored" });
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM public.set_bank_transaction_ignored_atomic($1, $2, false, $3)", [
          EMPRESA,
          tx,
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
    expect((await transacao(tx)).status).toBe("ignored");

    await fecho.end();
    await writer.end();
  }, 120_000);
});

describe("095 — superfície", () => {
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    ["confirm_bank_match_atomic", "p_company_id uuid, p_match_id uuid, p_actor_id uuid"],
    ["reject_bank_match_atomic", "p_company_id uuid, p_match_id uuid, p_actor_id uuid"],
    ["manual_bank_match_atomic", "p_company_id uuid, p_bank_tx_id uuid, p_entry_id uuid, p_actor_id uuid"],
    ["set_bank_transaction_ignored_atomic", "p_company_id uuid, p_bank_tx_id uuid, p_ignorar boolean, p_actor_id uuid"],
    [
      "create_cashflow_from_bank_transaction_atomic",
      "p_company_id uuid, p_bank_tx_id uuid, p_category text, p_actor_id uuid",
    ],
    ["delete_bank_import_atomic", "p_company_id uuid, p_import_id uuid, p_actor_id uuid"],
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
    const sql = readFileSync(join(ROOT, "supabase/migrations/095_bank_reconciliation_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/095_PRECONDITION_FAILED/);
  }, 120_000);
});
