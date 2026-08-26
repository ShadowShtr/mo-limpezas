/**
 * F14-B — desmarcar um pagamento não pode apagar histórico financeiro.
 *
 * B01–B12 do plano. Postgres 16 real, em contentor descartável: os pontos que
 * interessam aqui — cascade de conciliação, duas ligações a desmarcar ao mesmo
 * tempo, `FOR UPDATE` — não se reproduzem com um duplo em memória.
 *
 * As migrations em ensaio vivem em `supabase/migrations/draft/` e não têm
 * número: MIGRATION_NUMBER_FINAL = UNASSIGNED enquanto a 077/078/079 não
 * estiverem reconciliadas.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `f14b-safe-unmark-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const OLD_CATEGORY = "44444444-4444-4444-8444-444444444444";

let port = 0;
let pool: pg.Pool;

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

function readSql(...parts: string[]) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}

/**
 * O esqueleto mínimo. `profiles` existe porque as políticas RLS da migration a
 * referem; `bank_reconciliation_matches` traz o `ON DELETE CASCADE` real da
 * 043 — sem ele, o teste da conciliação não estaria a testar nada.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid);
  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, color text);
  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    year integer NOT NULL, month integer NOT NULL,
    status text NOT NULL CHECK (status IN ('open','closed')),
    UNIQUE(company_id, year, month));
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')), description text NOT NULL,
    amount numeric(10,2), due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false, period_year integer NOT NULL,
    period_month integer NOT NULL, paid_at timestamptz, notes text,
    expense_category_id uuid, attachment_url text, attachment_name text,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')), amount numeric(10,2) NOT NULL,
    description text NOT NULL, category text, date date NOT NULL,
    reference_id uuid, reference_type text,
    status text NOT NULL CHECK (status IN ('pendente','confirmado')),
    expense_category_id uuid, notes text, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries(company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
  CREATE TABLE public.bank_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending');
  CREATE TABLE public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    match_score integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    created_at timestamptz NOT NULL DEFAULT now());
  -- auth.uid() não existe fora do Supabase; as políticas só precisam que
  -- resolva. O schema auth sobrevive ao DROP SCHEMA public, portanto é
  -- largado explicitamente — senão o segundo reset falha a recriar a função.
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $auth$ SELECT NULL::uuid $auth$;
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* nunca abriu */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

async function reset() {
  await pool.query(BASELINE);
  await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
  await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
  await pool.query(readSql("supabase", "migrations", "draft",
    "PROVISIONAL_payment_cashflow_provenance.sql"));
  await pool.query(readSql("supabase", "migrations", "draft",
    "PROVISIONAL_safe_unmark_payment_paid.sql"));
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Empresa de ensaio')", [COMPANY]);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Outra empresa')", [OTHER_COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Fornecedores','violeta')",
    [CATEGORY, COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Legado','cinza')",
    [OLD_CATEGORY, COMPANY]);
}

async function payment(over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO fixed_variable_payments
       (id,company_id,kind,description,amount,status,recurring,period_year,period_month,expense_category_id)
     VALUES($1,$2,'variavel',$3,$4,'pendente',false,2026,7,$5)`,
    [id, over.company_id ?? COMPANY, over.description ?? "Pagamento a fornecedor",
      over.amount ?? 100, over.expense_category_id ?? null],
  );
  return id;
}

/** Um movimento legado, como o que a reparação das 6 adopta. */
async function legacyCash(paymentId: string, over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO cash_flow_entries
       (id,company_id,type,amount,description,category,date,reference_type,reference_id,
        status,expense_category_id,notes)
     VALUES($1,$2,'saida',$3,$4,'despesa',$5,'fixed_variable_payment',$6,'pendente',$7,$8)`,
    [id, over.company_id ?? COMPANY, over.amount ?? 100,
      over.description ?? "Movimento legado", over.date ?? "2026-07-10", paymentId,
      over.expense_category_id ?? OLD_CATEGORY, over.notes ?? "nota legada"],
  );
  return id;
}

const mark = (id: string, paidOn = "2026-08-26") =>
  pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, id, paidOn]);
const unmark = (id: string) =>
  pool.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]);

async function cashFor(paymentId: string) {
  return (await pool.query(
    `SELECT id::text, status, date::text, amount::text, type,
            expense_category_id::text, notes, created_at
       FROM cash_flow_entries
      WHERE reference_type='fixed_variable_payment' AND reference_id=$1`,
    [paymentId])).rows;
}

const paymentStatus = async (id: string) =>
  (await pool.query("SELECT status FROM fixed_variable_payments WHERE id=$1", [id])).rows[0].status;

const provenance = async (cashId: string) =>
  (await pool.query(
    `SELECT origin, prestate_date::text, prestate_expense_category_id::text
       FROM payment_cashflow_provenance WHERE cash_flow_entry_id=$1`, [cashId])).rows;

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=f14b",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "f14b", max: 12 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("F14-B — pagamento normal, sem movimento legado", () => {
  it("B01. marcar cria o movimento e regista que foi ele que o criou", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].status).toBe("confirmado");
    expect(await provenance(cash[0].id)).toEqual([
      { origin: "created_by_mark", prestate_date: null, prestate_expense_category_id: null },
    ]);
  });

  it("B02. repetir a marcação não cria um segundo movimento", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const primeiro = (await cashFor(id))[0].id;
    const segunda = await mark(id);
    expect(segunda.rows[0].ja_estava_pago).toBe(true);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(primeiro);
  });

  it("B03. desmarcar apaga o que a marcação criou — o comportamento canónico", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const resultado = await unmark(id);
    expect(resultado.rows[0].movimentos_removidos).toBe(1);
    expect(await cashFor(id)).toEqual([]);
    expect(await paymentStatus(id)).toBe("pendente");
  });
});

describe.sequential("F14-B — movimento legado adoptado", () => {
  it("B04. marcar adopta a linha que já lá estava, com o mesmo id", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect(cash[0].date).toBe("2026-08-26");
    expect(await provenance(legacy)).toEqual([
      { origin: "adopted_existing", prestate_date: "2026-07-10",
        prestate_expense_category_id: OLD_CATEGORY },
    ]);
  });

  it("B05. 🔴 desmarcar restaura a linha legada — não a apaga", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    const antes = (await cashFor(id))[0];
    await mark(id);
    const resultado = await unmark(id);

    expect(resultado.rows[0].movimentos_removidos).toBe(0);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
    expect(cash[0].date).toBe("2026-07-10");
    expect(cash[0].expense_category_id).toBe(OLD_CATEGORY);
    // O histórico do movimento legado sobrevive inteiro.
    expect(cash[0].notes).toBe(antes.notes);
    expect(cash[0].created_at).toEqual(antes.created_at);
    expect(await paymentStatus(id)).toBe("pendente");
  });

  it("B06. voltar a marcar reconfirma a mesma linha", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    await mark(id);
    await unmark(id);
    await mark(id, "2026-09-01");
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect(cash[0].date).toBe("2026-09-01");
    // O prestate continua a ser o estado legado verdadeiro, não o do ciclo.
    expect((await provenance(legacy))[0].prestate_date).toBe("2026-07-10");
  });

  it("ciclo completo: mark → unmark → mark preserva o id e não duplica", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    for (let volta = 0; volta < 3; volta += 1) {
      await mark(id);
      expect((await cashFor(id))[0].status).toBe("confirmado");
      await unmark(id);
      expect((await cashFor(id))[0].status).toBe("pendente");
    }
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
  });
});

describe.sequential("F14-B — conciliação", () => {
  it("B07. 🔴 desmarcar um movimento conciliado falha fechado", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const tx = randomUUID();
    await pool.query(
      "INSERT INTO bank_transactions(id,company_id,status) VALUES($1,$2,'reconciled')",
      [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'confirmed')`, [COMPANY, tx, legacy]);

    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_RECONCILED_CASHFLOW/);

    // Nada se moveu: nem o movimento, nem a correspondência, nem o pagamento.
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect((await pool.query(
      "SELECT count(*)::int n FROM bank_reconciliation_matches WHERE cash_flow_entry_id=$1",
      [legacy])).rows[0].n).toBe(1);
    expect(await paymentStatus(id)).toBe("pago");
  });

  it("B07b. o mesmo vale para um movimento que a marcação criou", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const cashId = (await cashFor(id))[0].id;
    const tx = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id) VALUES($1,$2)", [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'confirmed')`, [COMPANY, tx, cashId]);
    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_RECONCILED_CASHFLOW/);
    expect(await cashFor(id)).toHaveLength(1);
  });

  it("uma correspondência rejeitada não bloqueia — já não afirma nada", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const cashId = (await cashFor(id))[0].id;
    const tx = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id) VALUES($1,$2)", [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'rejected')`, [COMPANY, tx, cashId]);
    await expect(unmark(id)).resolves.toBeDefined();
  });
});

describe.sequential("F14-B — concorrência e integridade", () => {
  it("B08. duas ligações a desmarcar ao mesmo tempo serializam-se", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    const b = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await a.connect();
    await b.connect();
    try {
      const resultados = await Promise.allSettled([
        a.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
        b.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
      ]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const cash = await cashFor(id);
      expect(cash).toHaveLength(1);
      expect(cash[0].id).toBe(legacy);
      expect(cash[0].status).toBe("pendente");
      expect(cash[0].date).toBe("2026-07-10");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("B09. marcar e desmarcar em simultâneo não deixa estado misto", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    const b = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await a.connect();
    await b.connect();
    try {
      await Promise.allSettled([
        a.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
        b.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, id, "2026-08-27"]),
      ]);
      const cash = await cashFor(id);
      const estado = await paymentStatus(id);
      expect(cash).toHaveLength(1);
      expect(cash[0].id).toBe(legacy);
      // Seja qual for a ordem em que terminaram, os dois lados concordam.
      expect(cash[0].status).toBe(estado === "pago" ? "confirmado" : "pendente");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("B10. um movimento sem relação com o pagamento não é tocado", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const alheio = randomUUID();
    await pool.query(
      `INSERT INTO cash_flow_entries(id,company_id,type,amount,description,category,date,status)
       VALUES($1,$2,'saida',50,'Movimento manual','despesa','2026-07-01','confirmado')`,
      [alheio, COMPANY]);
    await unmark(id);
    const intacto = (await pool.query(
      "SELECT status, amount::text FROM cash_flow_entries WHERE id=$1", [alheio])).rows[0];
    expect(intacto).toEqual({ status: "confirmado", amount: "50.00" });
  });

  it("B11. um erro a meio reverte tudo — proveniência incluída", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
        [COMPANY, id, "2026-08-26"]);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
    const cash = await cashFor(id);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
    expect(cash[0].date).toBe("2026-07-10");
    expect(await provenance(legacy)).toEqual([]);
    expect(await paymentStatus(id)).toBe("pendente");
  });

  it("B12. proveniência de outra empresa não descreve um movimento desta", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    // Uma linha forjada não substitui a verdadeira: a chave primária é o
    // movimento, e já lá está a dizer que foi adoptado.
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'created_by_mark')`,
      [legacy, OTHER_COMPANY, id],
    )).rejects.toThrow();

    await unmark(id);
    // A verdade aguentou-se: restaurado, não apagado.
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
  });

  it("um registo de adopção sem data de origem é impossível de escrever", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'adopted_existing')`,
      [legacy, COMPANY, id],
    )).rejects.toThrow(/payment_cashflow_provenance_adopted_needs_prestate/);
  });

  it("sem proveniência, desmarcar apaga — o comportamento da 073", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    // Um movimento anterior a esta migration: existe, mas não tem registo.
    await pool.query("DELETE FROM payment_cashflow_provenance WHERE cash_flow_entry_id=$1", [legacy]);
    const resultado = await unmark(id);
    expect(resultado.rows[0].movimentos_removidos).toBe(1);
    expect(await cashFor(id)).toEqual([]);
  });
});
