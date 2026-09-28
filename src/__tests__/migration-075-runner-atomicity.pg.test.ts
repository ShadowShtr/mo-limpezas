import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const FILE = "075_cash_flow_fixed_variable_payment_reference.sql";
const ORIGINAL = readFileSync(join(ROOT, "supabase", "migrations", FILE), "utf8");
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "mig075-runner-"));
writeFileSync(join(FIXTURE_DIR, FILE), ORIGINAL, "utf8");

let container: PostgresContainer;
let pool: pg.Pool;

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY,
    reference_type text,
    CONSTRAINT cash_flow_entries_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN ('invoice','payroll','service_payment'))
  );
  CREATE TABLE public._migrations (
    name text PRIMARY KEY,
    checksum text,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function constraintDefinition(): Promise<string> {
  const { rows } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.cash_flow_entries'::regclass
       AND conname = 'cash_flow_entries_reference_type_check'
  `);
  return rows[0].definition as string;
}

async function run075({ failLedger = false, only = null }: { failLedger?: boolean; only?: string | null } = {}) {
  const session = await pool.connect();
  const client = {
    query(text: unknown, params?: unknown[]) {
      if (failLedger && typeof text === "string" && text.startsWith("INSERT INTO public._migrations")) {
        return Promise.reject(new Error("LEDGER_075_FORCED_FAILURE"));
      }
      return session.query(text as string, params);
    },
  };
  try {
    const target: Record<string, unknown> = only === null ? {} : { only };
    return await runMigrations({
      client,
      migrationsDir: FIXTURE_DIR,
      rootDir: ROOT,
      apply: true,
      log: () => {}, logWarn: () => {}, logError: () => {},
      ...target,
    });
  } finally {
    session.release();
  }
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: "mig075-runner",
    database: "atomic075",
    memory: "384m",
    cpus: "0.5",
  });
  pool = new pg.Pool({ ...container.connection, max: 3 });
}, 180_000);

beforeEach(async () => { await pool.query(BASELINE); });

afterAll(async () => {
  await pool?.end();
  container?.stop();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe.sequential("075 — atomicidade real entre schema e ledger", () => {
  it("falha exclusiva do ledger reverte a alteração do constraint", async () => {
    const before = await constraintDefinition();

    expect(await run075({ failLedger: true })).toMatchObject({
      exitCode: 1,
      transactionState: "ROLLED_BACK",
      failedMigration: FILE,
    });

    expect(await constraintDefinition()).toBe(before);
    expect(await constraintDefinition()).not.toContain("fixed_variable_payment");
    const ledger = await pool.query("SELECT count(*)::int AS n FROM public._migrations WHERE name=$1", [FILE]);
    expect(ledger.rows[0].n).toBe(0);
  });

  it("caminho feliz grava constraint e checksum original na mesma transação", async () => {
    expect((await run075()).exitCode).toBe(0);
    expect(await constraintDefinition()).toContain("fixed_variable_payment");
    const ledger = await pool.query("SELECT checksum FROM public._migrations WHERE name=$1", [FILE]);
    expect(ledger.rows[0]?.checksum).toBe(checksumForNewMigration(ORIGINAL));
  });

  it("retry depois do commit consulta o ledger e não executa novamente", async () => {
    expect((await run075()).exitCode).toBe(0);
    expect(await run075({ only: FILE })).toMatchObject({ exitCode: 0, targetState: "ALREADY_APPLIED" });
    const ledger = await pool.query("SELECT count(*)::int AS n FROM public._migrations WHERE name=$1", [FILE]);
    expect(ledger.rows[0].n).toBe(1);
  });
});
