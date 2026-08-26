import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PR81 = "a10c7b2bf059acd6ee2eaced65c07e2b409c0565";
const PR82 = "5eaee43d01025f7f8961a7a527219ab092957738";
const CONTAINER = `codex-adversarial-81-82-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const LOCK_KEY = 81082026;

let port = 0;
let pool: pg.Pool;
let runtimeRoot = "";
let dbUrl = "";
let migration079 = "";

function gitShow(sha: string, file: string): string {
  return execFileSync("git", ["show", `${sha}:${file}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "adversarial" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* connection never opened */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY,
    name text NOT NULL
  );

  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    name text NOT NULL,
    color text
  );

  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    status text NOT NULL CHECK (status IN ('open','closed')),
    UNIQUE(company_id, year, month)
  );

  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')),
    description text NOT NULL,
    amount numeric(10,2),
    due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false,
    period_year integer NOT NULL,
    period_month integer NOT NULL,
    paid_at timestamptz,
    notes text,
    expense_category_id uuid,
    attachment_url text,
    attachment_name text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')),
    amount numeric(10,2) NOT NULL,
    description text NOT NULL,
    category text,
    date date NOT NULL,
    reference_id uuid,
    reference_type text,
    status text NOT NULL CHECK (status IN ('pendente','confirmado')),
    expense_category_id uuid,
    notes text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries(company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

  CREATE TABLE public.bank_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    bank_transaction_id uuid REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'confirmed'
  );

  CREATE TABLE public.attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    parent_type text NOT NULL,
    parent_id uuid NOT NULL,
    storage_bucket text NOT NULL,
    storage_path text NOT NULL,
    original_name text NOT NULL
  );
`;

async function resetDatabase() {
  await pool.query(BASELINE);
  await pool.query(fs.readFileSync(path.join(ROOT, "supabase/migrations/073_payment_to_cashflow.sql"), "utf8"));
  await pool.query(migration079);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Test company')", [COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Suppliers','violet')",
    [CATEGORY, COMPANY],
  );
}

async function payment(over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO fixed_variable_payments
       (id,company_id,kind,description,amount,status,recurring,period_year,period_month,notes,expense_category_id)
     VALUES($1,$2,'variavel',$3,$4,'pendente',false,$5,$6,$7,$8)`,
    [id, over.company_id ?? COMPANY, over.description ?? "Supplier payment", over.amount ?? 100,
      over.period_year ?? 2026, over.period_month ?? 7, over.notes ?? null,
      over.expense_category_id ?? null],
  );
  return id;
}

async function linkedCash(paymentId: string, over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO cash_flow_entries
       (id,company_id,type,amount,description,category,date,reference_type,reference_id,status,
        expense_category_id,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,'fixed_variable_payment',$8,$9,$10,$11)`,
    [id, over.company_id ?? COMPANY, over.type ?? "saida", over.amount ?? 100,
      over.description ?? "Legacy supplier entry", over.category ?? "despesa",
      over.date ?? "2026-07-10", paymentId, over.status ?? "pendente",
      over.expense_category_id ?? null, over.notes ?? "legacy"],
  );
  return id;
}

function mark(client: pg.Pool | pg.Client, paymentId: string, paidOn = "2026-08-26") {
  return client.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, paymentId, paidOn]);
}

function unmark(paymentId: string) {
  return pool.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, paymentId]);
}

async function cashFor(paymentId: string) {
  return (await pool.query(
    `SELECT id::text,type,amount::text,status,date::text,company_id::text,
            reference_type,reference_id::text,description,category,expense_category_id::text,notes
       FROM cash_flow_entries
      WHERE reference_type='fixed_variable_payment' AND reference_id=$1`,
    [paymentId],
  )).rows;
}

async function paymentState(paymentId: string) {
  return (await pool.query(
    "SELECT status,paid_at,description,amount::text,period_year,period_month,expense_category_id::text,notes FROM fixed_variable_payments WHERE id=$1",
    [paymentId],
  )).rows[0];
}

async function waitForAdvisoryWait(applicationName: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'`,
      [applicationName],
    );
    if (result.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Connection ${applicationName} never reached the race gate.`);
}

async function raceWithConflictingCash(over: Record<string, unknown>) {
  await resetDatabase();
  const paymentId = await payment({ description: "Race payment", amount: 100 });
  await pool.query(`
    CREATE FUNCTION pause_rpc_cash_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.description = 'Race payment' THEN
        PERFORM pg_advisory_xact_lock(${LOCK_KEY});
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER pause_rpc_cash_insert BEFORE INSERT ON cash_flow_entries
      FOR EACH ROW EXECUTE FUNCTION pause_rpc_cash_insert();
  `);

  const blocker = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "adversarial" });
  const actor = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "adversarial", application_name: "race-actor" });
  await blocker.connect();
  await actor.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const marking = mark(actor, paymentId);
    await waitForAdvisoryWait("race-actor");
    const intruder = await linkedCash(paymentId, {
      description: "Concurrent incompatible row",
      ...over,
    });
    await blocker.query("COMMIT");
    const result = await marking;
    return { paymentId, intruder, result, rows: await cashFor(paymentId) };
  } finally {
    try { await blocker.query("ROLLBACK"); } catch { /* already committed */ }
    await blocker.end();
    await actor.end();
  }
}

function runExecutor(args: string[]) {
  return spawnSync(process.execPath, [
    path.join(runtimeRoot, "scripts/repairs/six-pending-obligations.mjs"),
    "--database-url", dbUrl,
    ...args,
  ], { cwd: runtimeRoot, encoding: "utf8" });
}

const SIX = [
  ["Invoice A", "100.00", "2026-07-10", null],
  ["Invoice B", "200.50", "2026-07-22", null],
  ["Invoice C", "300.25", "2026-08-03", CATEGORY],
  ["Invoice D", "400.00", "2026-08-07", null],
  ["Invoice E", "500.75", "2026-08-11", null],
  ["Invoice F", "600.00", "2026-08-19", null],
] as const;

async function seedSix() {
  const ids: string[] = [];
  for (const [description, amount, date, categoryId] of SIX) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO cash_flow_entries
         (id,company_id,type,amount,description,category,date,status,expense_category_id,notes)
       VALUES($1,$2,'saida',$3,$4,'despesa',$5,'pendente',$6,'legacy note')`,
      [id, COMPANY, amount, description, date, categoryId],
    );
  }
  return ids;
}

type RepairContext = {
  directory: string;
  forwardPath: string;
  rollbackPath: string;
  forward: {
    sha256: string;
    linhas: Array<{
      legacy_cashflow_id: string;
      target_payment_id: string;
    }>;
  };
  rollback: {
    sha256: string;
    passos: Array<Record<string, unknown>>;
  };
};

async function prepareRepair(): Promise<RepairContext> {
  await resetDatabase();
  await seedSix();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-81-82-manifest-"));
  const dry = runExecutor(["--out", directory]);
  if (dry.status !== 0) throw new Error(`${dry.stdout}\n${dry.stderr}`);
  const forwardPath = path.join(directory, "six-forward.json");
  const rollbackPath = path.join(directory, "six-rollback.json");
  return {
    directory,
    forwardPath,
    rollbackPath,
    forward: JSON.parse(fs.readFileSync(forwardPath, "utf8")),
    rollback: JSON.parse(fs.readFileSync(rollbackPath, "utf8")),
  };
}

function applyRepair(context: RepairContext) {
  return runExecutor([
    "--apply", "--confirm-production", "ENSAIO-DESCARTAVEL",
    "--manifest", context.forwardPath, "--manifest-sha", context.forward.sha256,
  ]);
}

function rollbackRepair(context: RepairContext) {
  return runExecutor([
    "--rollback", "--confirm-production", "ENSAIO-DESCARTAVEL",
    "--manifest", context.rollbackPath, "--manifest-sha", context.rollback.sha256,
  ]);
}

async function counts() {
  const payments = Number((await pool.query("SELECT count(*) n FROM fixed_variable_payments")).rows[0].n);
  const linked = Number((await pool.query("SELECT count(*) n FROM cash_flow_entries WHERE reference_type='fixed_variable_payment'")).rows[0].n);
  return { payments, linked };
}

beforeAll(async () => {
  expect(execFileSync("git", ["rev-parse", PR81], { cwd: ROOT, encoding: "utf8" }).trim()).toBe(PR81);
  expect(execFileSync("git", ["rev-parse", PR82], { cwd: ROOT, encoding: "utf8" }).trim()).toBe(PR82);

  migration079 = gitShow(PR81, "supabase/migrations/079_reuse_pending_cashflow_on_payment.sql");
  runtimeRoot = fs.mkdtempSync(path.join(ROOT, ".codex-adversarial-runtime-"));
  fs.mkdirSync(path.join(runtimeRoot, "scripts/repairs/lib"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "scripts/repairs/six-pending-obligations.mjs"),
    gitShow(PR82, "scripts/repairs/six-pending-obligations.mjs"),
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "scripts/repairs/lib/six-pending-core.mjs"),
    gitShow(PR82, "scripts/repairs/lib/six-pending-core.mjs"),
  );
  fs.symlinkSync(
    path.join(ROOT, "node_modules"),
    path.join(runtimeRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=adversarial",
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Invalid Docker port: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "adversarial", max: 12 });
  const protocol = "postgres" + "ql";
  dbUrl = `${protocol}://postgres@127.0.0.1:${port}/adversarial`;
}, 90_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

describe.sequential("#81 exact HEAD - conflict revalidation and concurrency", () => {
  it.each([
    ["wrong type", { type: "entrada", category: "faturacao" }],
    ["wrong amount", { amount: 999 }],
    ["wrong status", { status: "pendente" }],
  ])("F14-A CURRENT: ON CONFLICT accepts a concurrent %s row without revalidation", async (_label, over) => {
    const result = await raceWithConflictingCash(over);
    expect(result.result.rows[0].cash_entry_id).toBe(result.intruder);
    expect(result.rows).toHaveLength(1);
    expect((await paymentState(result.paymentId)).status).toBe("pago");
  });

  it("F14-A company mismatch cannot collide with the company-scoped key", async () => {
    await resetDatabase();
    const id = await payment();
    await pool.query("INSERT INTO companies(id,name) VALUES($1,'Other company')", [OTHER_COMPANY]);
    await linkedCash(id, { company_id: OTHER_COMPANY });
    await mark(pool, id);
    expect(Number((await pool.query(
      "SELECT count(*) n FROM cash_flow_entries WHERE company_id=$1 AND reference_id=$2",
      [COMPANY, id],
    )).rows[0].n)).toBe(1);
    expect(Number((await pool.query("SELECT count(*) n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n)).toBe(2);
  });

  it("F14-A wrong reference linkage cannot replace the payment key", async () => {
    await resetDatabase();
    const mine = await payment();
    const other = await payment();
    await linkedCash(other);
    await mark(pool, mine);
    expect(await cashFor(mine)).toHaveLength(1);
    expect((await cashFor(other))[0].status).toBe("pendente");
  });

  it("F14-A/B two real connections serialize simultaneous mark calls to one cash row", async () => {
    await resetDatabase();
    const id = await payment();
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "adversarial" });
    const b = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "adversarial" });
    await a.connect();
    await b.connect();
    try {
      const results = await Promise.all([mark(a, id), mark(b, id)]);
      expect(results).toHaveLength(2);
      expect(await cashFor(id)).toHaveLength(1);
      expect((await paymentState(id)).status).toBe("pago");
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe.sequential("#81 exact HEAD - provenance, reconciliation and periods", () => {
  it("F14-B CURRENT: unmark deletes a reused legacy cashflow", async () => {
    await resetDatabase();
    const id = await payment();
    const legacy = await linkedCash(id);
    await mark(pool, id);
    expect((await cashFor(id))[0].id).toBe(legacy);
    await unmark(id);
    expect(await cashFor(id)).toEqual([]);
    expect((await paymentState(id)).status).toBe("pendente");
  });

  it.fails("F14-B DESIRED: unmark restores a reused legacy row instead of deleting it", async () => {
    await resetDatabase();
    const id = await payment();
    const legacy = await linkedCash(id, { date: "2026-07-10" });
    await mark(pool, id, "2026-08-26");
    await unmark(id);
    expect(await cashFor(id)).toEqual([
      expect.objectContaining({ id: legacy, status: "pendente", date: "2026-07-10" }),
    ]);
  });

  it("normal mark -> unmark -> mark keeps one row at each stage", async () => {
    await resetDatabase();
    const id = await payment();
    await mark(pool, id);
    const first = (await cashFor(id))[0].id;
    await unmark(id);
    expect(await cashFor(id)).toHaveLength(0);
    await mark(pool, id);
    const second = (await cashFor(id))[0].id;
    expect(second).not.toBe(first);
    expect(await cashFor(id)).toHaveLength(1);
  });

  it("F14-B CURRENT: unmark deletes reconciled evidence and cascades its match", async () => {
    await resetDatabase();
    const id = await payment();
    const legacy = await linkedCash(id);
    await mark(pool, id);
    const bankId = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id,status) VALUES($1,$2,'reconciled')", [bankId, COMPANY]);
    await pool.query(
      "INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status) VALUES($1,$2,$3,'confirmed')",
      [COMPANY, bankId, legacy],
    );
    await unmark(id);
    expect(Number((await pool.query("SELECT count(*) n FROM bank_reconciliation_matches")).rows[0].n)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) n FROM bank_transactions WHERE status='reconciled'")).rows[0].n)).toBe(1);
  });

  it.fails("F14-B DESIRED: unmark refuses reconciled cash evidence", async () => {
    await resetDatabase();
    const id = await payment();
    const legacy = await linkedCash(id);
    await mark(pool, id);
    const bankId = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id,status) VALUES($1,$2,'reconciled')", [bankId, COMPANY]);
    await pool.query(
      "INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status) VALUES($1,$2,$3,'confirmed')",
      [COMPANY, bankId, legacy],
    );
    await expect(unmark(id)).rejects.toThrow();
  });

  it.each([
    { label: "competence open / cash closed", competenceClosed: false, cashClosed: true, succeeds: true },
    { label: "competence closed / cash open", competenceClosed: true, cashClosed: false, succeeds: false },
    { label: "both open", competenceClosed: false, cashClosed: false, succeeds: true },
    { label: "both closed", competenceClosed: true, cashClosed: true, succeeds: false },
  ])("PERIOD CURRENT: $label -> success=$succeeds", async ({ competenceClosed, cashClosed, succeeds }) => {
    await resetDatabase();
    const id = await payment({ period_year: 2026, period_month: 7 });
    if (competenceClosed) {
      await pool.query("INSERT INTO financial_periods(company_id,year,month,status) VALUES($1,2026,7,'closed')", [COMPANY]);
    }
    if (cashClosed) {
      await pool.query("INSERT INTO financial_periods(company_id,year,month,status) VALUES($1,2026,8,'closed')", [COMPANY]);
    }
    if (succeeds) {
      await expect(mark(pool, id, "2026-08-26")).resolves.toBeDefined();
    } else {
      await expect(mark(pool, id, "2026-08-26")).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    }
  });
});

describe.sequential("#82 exact HEAD - manifest staleness and batch guarantees", () => {
  const cases = [
    { field: "description", sql: "UPDATE cash_flow_entries SET description='changed after manifest' WHERE id=$1", usesSecondValue: false, protectedByManifest: false },
    { field: "amount", sql: "UPDATE cash_flow_entries SET amount=999 WHERE id=$1", usesSecondValue: false, protectedByManifest: true },
    { field: "date", sql: "UPDATE cash_flow_entries SET date='2026-09-01' WHERE id=$1", usesSecondValue: false, protectedByManifest: false },
    { field: "status", sql: "UPDATE cash_flow_entries SET status='confirmado' WHERE id=$1", usesSecondValue: false, protectedByManifest: true },
    { field: "category", sql: "UPDATE cash_flow_entries SET category='new classification' WHERE id=$1", usesSecondValue: false, protectedByManifest: false },
    { field: "expense_category_id", sql: "UPDATE cash_flow_entries SET expense_category_id=$2 WHERE id=$1", usesSecondValue: true, protectedByManifest: false },
    { field: "reference_type", sql: "UPDATE cash_flow_entries SET reference_type='manual-edit' WHERE id=$1", usesSecondValue: false, protectedByManifest: true },
    { field: "reference_id", sql: "UPDATE cash_flow_entries SET reference_id=$2 WHERE id=$1", usesSecondValue: true, protectedByManifest: true },
    { field: "company", sql: "UPDATE cash_flow_entries SET company_id=$2 WHERE id=$1", usesSecondValue: true, protectedByManifest: true },
    { field: "notes", sql: "UPDATE cash_flow_entries SET notes='changed after manifest' WHERE id=$1", usesSecondValue: false, protectedByManifest: false },
    { field: "type", sql: "UPDATE cash_flow_entries SET type='entrada' WHERE id=$1", usesSecondValue: false, protectedByManifest: true },
    { field: "created_at", sql: "UPDATE cash_flow_entries SET created_at=created_at + interval '1 hour' WHERE id=$1", usesSecondValue: false, protectedByManifest: false },
  ];

  it.each(cases)("F14-C manifest field $field protected=$protectedByManifest", async ({ sql, usesSecondValue, protectedByManifest }) => {
    const context = await prepareRepair();
    const first = context.forward.linhas[0];
    const values = usesSecondValue ? [first.legacy_cashflow_id, randomUUID()] : [first.legacy_cashflow_id];
    await pool.query(sql, values);
    const result = applyRepair(context);
    expect(result.status !== 0).toBe(protectedByManifest);
    expect((await counts()).payments).toBe(protectedByManifest ? 0 : 6);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("category staleness succeeds and gives the payment the stale category", async () => {
    const context = await prepareRepair();
    const first = context.forward.linhas[0];
    await pool.query("UPDATE cash_flow_entries SET expense_category_id=$2 WHERE id=$1", [first.legacy_cashflow_id, CATEGORY]);
    expect(applyRepair(context).status).toBe(0);
    const paymentRow = await paymentState(first.target_payment_id);
    expect(paymentRow.expense_category_id).toBeNull();
    expect((await pool.query("SELECT expense_category_id::text id FROM cash_flow_entries WHERE id=$1", [first.legacy_cashflow_id])).rows[0].id).toBe(CATEGORY);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("date staleness succeeds and keeps competence from the obsolete manifest", async () => {
    const context = await prepareRepair();
    const first = context.forward.linhas[0];
    await pool.query("UPDATE cash_flow_entries SET date='2026-09-01' WHERE id=$1", [first.legacy_cashflow_id]);
    expect(applyRepair(context).status).toBe(0);
    const state = await paymentState(first.target_payment_id);
    expect([state.period_year, state.period_month]).toEqual([2026, 7]);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("target payment id collision rolls the whole batch back", async () => {
    const context = await prepareRepair();
    await payment({ id: context.forward.linhas[3].target_payment_id, description: "collision" });
    const before = await counts();
    expect(applyRepair(context).status).not.toBe(0);
    expect(await counts()).toEqual(before);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("second apply safely rejects without duplicates", async () => {
    const context = await prepareRepair();
    expect(applyRepair(context).status).toBe(0);
    const first = await counts();
    expect(applyRepair(context).status).not.toBe(0);
    expect(await counts()).toEqual(first);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it.each([1, 2, 3, 4, 5])("mid-batch failure after %i completed item(s) persists zero payments", async (completedItems) => {
    const context = await prepareRepair();
    await pool.query(
      "UPDATE cash_flow_entries SET amount=999 WHERE id=$1",
      [context.forward.linhas[completedItems].legacy_cashflow_id],
    );
    expect(applyRepair(context).status).not.toBe(0);
    expect((await counts()).payments).toBe(0);
    expect((await counts()).linked).toBe(0);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("attachment created for a target id before apply is silently adopted", async () => {
    const context = await prepareRepair();
    const target = context.forward.linhas[0].target_payment_id;
    await pool.query(
      `INSERT INTO attachments(company_id,parent_type,parent_id,storage_bucket,storage_path,original_name)
       VALUES($1,'fixed_variable_payment',$2,'payments','preexisting/path.pdf','before.pdf')`,
      [COMPANY, target],
    );
    expect(applyRepair(context).status).toBe(0);
    expect(Number((await pool.query("SELECT count(*) n FROM attachments WHERE parent_id=$1", [target])).rows[0].n)).toBe(1);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });
});

describe.sequential("#82 exact HEAD - rollback after real activity", () => {
  async function appliedRepair() {
    const context = await prepareRepair();
    expect(applyRepair(context).status).toBe(0);
    return context;
  }

  it("rollback after paid refuses all", async () => {
    const context = await appliedRepair();
    const first = context.forward.linhas[0];
    await mark(pool, first.target_payment_id);
    const before = await counts();
    expect(rollbackRepair(context).status).not.toBe(0);
    expect(await counts()).toEqual(before);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it("F14-B exact #82 repair -> mark -> unmark deletes the reused legacy movement", async () => {
    const context = await appliedRepair();
    const first = context.forward.linhas[0];
    await mark(pool, first.target_payment_id);
    expect((await cashFor(first.target_payment_id))[0].id).toBe(first.legacy_cashflow_id);
    await unmark(first.target_payment_id);
    expect(await cashFor(first.target_payment_id)).toEqual([]);
    expect(Number((await pool.query(
      "SELECT count(*) n FROM cash_flow_entries WHERE id=$1",
      [first.legacy_cashflow_id],
    )).rows[0].n)).toBe(0);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it.each([
    { field: "payment description", sql: "UPDATE fixed_variable_payments SET description='edited' WHERE id=$1", usesSecondValue: false },
    { field: "payment category", sql: "UPDATE fixed_variable_payments SET expense_category_id=$2 WHERE id=$1", usesSecondValue: true },
    { field: "payment notes", sql: "UPDATE fixed_variable_payments SET notes='edited' WHERE id=$1", usesSecondValue: false },
    { field: "payment competence", sql: "UPDATE fixed_variable_payments SET period_month=9 WHERE id=$1", usesSecondValue: false },
    { field: "cash date", sql: "UPDATE cash_flow_entries SET date='2026-09-02' WHERE reference_id=$1", usesSecondValue: false },
    { field: "cash category", sql: "UPDATE cash_flow_entries SET expense_category_id=$2 WHERE reference_id=$1", usesSecondValue: true },
    { field: "cash notes", sql: "UPDATE cash_flow_entries SET notes='edited' WHERE reference_id=$1", usesSecondValue: false },
  ])("F14-C CURRENT: rollback after $field edit is accepted", async ({ sql, usesSecondValue }) => {
    const context = await appliedRepair();
    const target = context.forward.linhas[0].target_payment_id;
    await pool.query(sql, usesSecondValue ? [target, CATEGORY] : [target]);
    expect(rollbackRepair(context).status).toBe(0);
    expect((await counts()).payments).toBe(0);
    fs.rmSync(context.directory, { recursive: true, force: true });
  });

  it.fails("F14-C DESIRED: any payment edit makes rollback refuse all", async () => {
    const context = await appliedRepair();
    const target = context.forward.linhas[0].target_payment_id;
    await pool.query("UPDATE fixed_variable_payments SET description='edited' WHERE id=$1", [target]);
    expect(rollbackRepair(context).status).not.toBe(0);
  });

  it("F14-C CURRENT: rollback leaves a payment attachment orphaned", async () => {
    const context = await appliedRepair();
    const target = context.forward.linhas[0].target_payment_id;
    await pool.query(
      `INSERT INTO attachments(company_id,parent_type,parent_id,storage_bucket,storage_path,original_name)
       VALUES($1,'fixed_variable_payment',$2,'payments','after/path.pdf','after.pdf')`,
      [COMPANY, target],
    );
    expect(rollbackRepair(context).status).toBe(0);
    expect(Number((await pool.query("SELECT count(*) n FROM attachments WHERE parent_id=$1", [target])).rows[0].n)).toBe(1);
    expect((await paymentState(target))).toBeUndefined();
    fs.rmSync(context.directory, { recursive: true, force: true });
  });
});
