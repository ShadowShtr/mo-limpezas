/**
 * F14-A — a mesma corrida contra as duas versões da 079.
 *
 * O harness adversarial do Codex (PR #85) lê a 079 fixada em `a10c7b2b`. É uma
 * reprodução histórica do defeito e continua válida como tal — não se toca nela
 * e não se muda o pin: perder-se-ia a prova de que o bug existiu mesmo.
 *
 * O que falta é a outra metade: que a HEAD corrigida o fecha. Este ficheiro
 * corre o mesmo cenário duas vezes, uma por cada versão da migration, e exige
 * que a antiga reproduza e a nova bloqueie. Um teste que só afirmasse «a nova
 * está bem» não provaria que o cenário ainda é capaz de apanhar o defeito.
 *
 * Requer Docker. Postgres 16 real, duas ligações, um trigger como barreira
 * determinística — não `pg_sleep`, que só torna a corrida provável.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OLD_PR81_SHA = "a10c7b2bf059acd6ee2eaced65c07e2b409c0565";
const MIGRATION = "supabase/migrations/079_reuse_pending_cashflow_on_payment.sql";
const BASE_MIGRATION = "supabase/migrations/073_payment_to_cashflow.sql";
const CONTAINER = `f14a-old-vs-new-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const LOCK_KEY = 81082026;

let port = 0;
let pool: pg.Pool;
let oldMigration = "";
let newMigration = "";
let baseMigration = "";

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

function gitShow(ref: string, file: string): string {
  return execFileSync("git", ["show", `${ref}:${file}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
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
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14a" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* nunca chegou a abrir */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

/** Instala a baseline, a 073 e a versão da 079 que se quer exercitar. */
async function installVersion(sql: string) {
  await pool.query(BASELINE);
  await pool.query(baseMigration);
  await pool.query(sql);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Empresa de ensaio')", [COMPANY]);
}

type Intruder = { type?: string; amount?: number; status?: string };

type RaceOutcome =
  | { raised: false; rows: Array<Record<string, unknown>> }
  | { raised: true; message: string };

/**
 * A ligação A entra na RPC e pára imediatamente antes do INSERT, presa num
 * advisory lock que B detém. B insere a linha concorrente e larga a tranca. A
 * continua e embate no `ON CONFLICT`.
 */
async function race(sql: string, over: Intruder) {
  await installVersion(sql);
  const paymentId = randomUUID();
  await pool.query(
    `INSERT INTO fixed_variable_payments
       (id,company_id,kind,description,amount,status,recurring,period_year,period_month)
     VALUES($1,$2,'variavel','Race payment',100,'pendente',false,2026,7)`,
    [paymentId, COMPANY],
  );
  await pool.query(`
    CREATE OR REPLACE FUNCTION pause_rpc_cash_insert() RETURNS trigger LANGUAGE plpgsql AS $trg$
    BEGIN
      IF NEW.description = 'Race payment' THEN
        PERFORM pg_advisory_xact_lock(${LOCK_KEY});
      END IF;
      RETURN NEW;
    END $trg$;
    DROP TRIGGER IF EXISTS pause_rpc_cash_insert ON cash_flow_entries;
    CREATE TRIGGER pause_rpc_cash_insert BEFORE INSERT ON cash_flow_entries
      FOR EACH ROW EXECUTE FUNCTION pause_rpc_cash_insert();
  `);

  const blocker = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14a" });
  const actor = new pg.Client({
    host: "127.0.0.1", port, user: "postgres", database: "f14a", application_name: "race-actor",
  });
  await blocker.connect();
  await actor.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);

    const marking: Promise<RaceOutcome> = actor
      .query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, paymentId, "2026-08-26"])
      .then((r) => ({ raised: false as const, rows: r.rows }))
      .catch((e: Error) => ({ raised: true as const, message: e.message }));

    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE application_name='race-actor' AND wait_event_type='Lock' AND wait_event='advisory'`,
      );
      if (waiting.rowCount === 1) break;
      if (Date.now() > deadline) throw new Error("A ligação nunca chegou à barreira.");
      await new Promise((r) => setTimeout(r, 20));
    }

    const intruder = randomUUID();
    await pool.query(
      `INSERT INTO cash_flow_entries
         (id,company_id,type,amount,description,category,date,reference_type,reference_id,status)
       VALUES($1,$2,$3,$4,'Concurrent incompatible row','despesa','2026-07-10',
              'fixed_variable_payment',$5,$6)`,
      [intruder, COMPANY, over.type ?? "saida", over.amount ?? 100, paymentId, over.status ?? "pendente"],
    );
    await blocker.query("COMMIT");

    const outcome = await marking;
    const payment = (await pool.query(
      "SELECT status FROM fixed_variable_payments WHERE id=$1", [paymentId])).rows[0];
    const cash = (await pool.query(
      `SELECT id::text, type, amount::text, status FROM cash_flow_entries
        WHERE reference_type='fixed_variable_payment' AND reference_id=$1`, [paymentId])).rows;
    return { outcome, payment, cash, intruder };
  } finally {
    try { await blocker.query("ROLLBACK"); } catch { /* já tinha feito COMMIT */ }
    await blocker.end();
    await actor.end();
  }
}

beforeAll(async () => {
  oldMigration = gitShow(OLD_PR81_SHA, MIGRATION);
  newMigration = gitShow("HEAD", MIGRATION);
  baseMigration = gitShow("HEAD", BASE_MIGRATION);

  // Se as duas versões forem iguais este ficheiro não está a comparar nada.
  expect(oldMigration).not.toEqual(newMigration);

  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=f14a",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "f14a", max: 12 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("F14-A — a versão antiga reproduz o defeito", () => {
  it.each([
    ["tipo errado", { type: "entrada" } as Intruder],
    ["valor errado", { amount: 999 } as Intruder],
  ])("OLD %s: a linha incompatível é aceite sem revalidação", async (_label, over) => {
    const r = await race(oldMigration, over);
    expect(r.outcome.raised).toBe(false);
    expect(r.cash[0].id).toBe(r.intruder);
    expect(r.payment.status).toBe("pago");
  });

  it("OLD linha válida em pendente: fica presa em pendente com o pagamento pago", async () => {
    const r = await race(oldMigration, {});
    expect(r.outcome.raised).toBe(false);
    expect(r.payment.status).toBe("pago");
    // 🔴 A divergência silenciosa: dinheiro dado como saído, movimento por confirmar.
    expect(r.cash[0].status).toBe("pendente");
  });
});

describe.sequential("F14-A — a HEAD corrigida fecha-o", () => {
  it.each([
    ["tipo errado", { type: "entrada" } as Intruder, "CASHFLOW_LINK_TYPE_MISMATCH"],
    ["valor errado", { amount: 999 } as Intruder, "CASHFLOW_LINK_AMOUNT_MISMATCH"],
  ])("NEW %s: falha fechado e reverte tudo", async (_label, over, code) => {
    const r = await race(newMigration, over);
    expect(r.outcome.raised).toBe(true);
    if (r.outcome.raised) expect(r.outcome.message).toContain(code);
    // A transacção inteira reverteu: o pagamento não ficou pago.
    expect(r.payment.status).toBe("pendente");
  });

  it("NEW linha válida em pendente: mesma linha, convertida para confirmado", async () => {
    const r = await race(newMigration, {});
    expect(r.outcome.raised).toBe(false);
    expect(r.payment.status).toBe("pago");
    expect(r.cash).toHaveLength(1);
    expect(r.cash[0].id).toBe(r.intruder);
    expect(r.cash[0].status).toBe("confirmado");
  });

  it("NEW a divergência «pago + pendente» deixa de ser possível", async () => {
    const r = await race(newMigration, {});
    expect({ pagamento: r.payment.status, movimento: r.cash[0].status })
      .not.toEqual({ pagamento: "pago", movimento: "pendente" });
  });

  it("NEW status impossível: falha fechado", async () => {
    await installVersion(newMigration);
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO fixed_variable_payments
         (id,company_id,kind,description,amount,status,recurring,period_year,period_month)
       VALUES($1,$2,'variavel','Estado impossivel',100,'pendente',false,2026,7)`,
      [paymentId, COMPANY],
    );
    // O CHECK da tabela não deixa escrever um estado fora do conjunto; larga-se
    // só para poder construir a linha que a função tem de recusar.
    await pool.query("ALTER TABLE cash_flow_entries DROP CONSTRAINT cash_flow_entries_status_check");
    await pool.query(
      `INSERT INTO cash_flow_entries
         (company_id,type,amount,description,category,date,reference_type,reference_id,status)
       VALUES($1,'saida',100,'Estado impossivel','despesa','2026-07-10',
              'fixed_variable_payment',$2,'arquivado')`,
      [COMPANY, paymentId],
    );
    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, paymentId, "2026-08-26"]),
    ).rejects.toThrow(/CASHFLOW_LINK_STATUS_UNEXPECTED/);
    expect((await pool.query("SELECT status FROM fixed_variable_payments WHERE id=$1",
      [paymentId])).rows[0].status).toBe("pendente");
  });

  it("NEW cross-company: uma linha de outra empresa nunca é adoptada", async () => {
    await installVersion(newMigration);
    await pool.query("INSERT INTO companies(id,name) VALUES($1,'Outra empresa')", [OTHER_COMPANY]);
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO fixed_variable_payments
         (id,company_id,kind,description,amount,status,recurring,period_year,period_month)
       VALUES($1,$2,'variavel','Cross company',100,'pendente',false,2026,7)`,
      [paymentId, COMPANY],
    );
    await pool.query(
      `INSERT INTO cash_flow_entries
         (company_id,type,amount,description,category,date,reference_type,reference_id,status)
       VALUES($1,'saida',100,'Da outra empresa','despesa','2026-07-10',
              'fixed_variable_payment',$2,'pendente')`,
      [OTHER_COMPANY, paymentId],
    );
    await pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
      [COMPANY, paymentId, "2026-08-26"]);
    // A da outra empresa não foi tocada; a desta foi criada de novo.
    expect((await pool.query(
      "SELECT status FROM cash_flow_entries WHERE company_id=$1 AND reference_id=$2",
      [OTHER_COMPANY, paymentId])).rows[0].status).toBe("pendente");
    expect((await pool.query(
      "SELECT count(*)::int n FROM cash_flow_entries WHERE company_id=$1 AND reference_id=$2",
      [COMPANY, paymentId])).rows[0].n).toBe(1);
  });
});
