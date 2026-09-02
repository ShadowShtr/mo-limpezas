/**
 * 088 — prestate fail-closed e atomicidade schema ↔ ledger.
 *
 * A base e o runner são reais. O único erro injectado é o INSERT da linha
 * 088 no ledger; o wrapper não intercepta nenhuma query de schema.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const ROOT = process.cwd();
const FILE = "088_payment_competence_idempotent_edit.sql";
const PRESTATE_HASH = "fdb9af8955ad0252139f673cbdf5d21e";
const POSTSTATE_HASH = "a227a222d9a94852c5b3e086a6a31c78";
const CONTAINER = `mig088-${process.pid}`;
let port = 0;
let pool: pg.Pool;

const docker = (args: string[]) => spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });

function baselineFromExistingPostgresSuite(): string {
  const source = readFileSync(join(ROOT, "src/__tests__/atomic-finance-mutations-postgres.test.ts"), "utf8");
  const tick = String.fromCharCode(96);
  const match = source.match(new RegExp("const BASELINE = " + tick + "([\\s\\S]*?)" + tick + ";"));
  if (!match) throw new Error("BASELINE PostgreSQL não encontrado.");
  return match[1];
}

async function waitForPostgres() {
  for (let i = 0; i < 180; i++) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "atomic"]).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("PostgreSQL 17 não ficou pronto.");
}

async function applyPrestate() {
  const client = await pool.connect();
  try {
    await client.query(baselineFromExistingPostgresSuite());
    for (const file of [
      "073_payment_to_cashflow.sql",
      "079_reuse_pending_cashflow_on_payment.sql",
      "080_payment_cashflow_provenance.sql",
    ]) await client.query(readFileSync(join(ROOT, "supabase/migrations", file), "utf8"));
    await client.query("INSERT INTO public._migrations(name, checksum) VALUES ('080_payment_cashflow_provenance.sql', 'ensaio')");
    for (const file of ["081_safe_unmark_payment_paid.sql", "082_atomic_finance_mutations.sql", "083_payment_authorization_hardening.sql"]) {
      await client.query(readFileSync(join(ROOT, "supabase/migrations", file), "utf8"));
    }
    await client.query("INSERT INTO public._migrations(name, checksum) VALUES ('087_equipas_r4.sql', 'ensaio')");
  } finally {
    client.release();
  }
}

async function functionFingerprint(): Promise<string> {
  const { rows } = await pool.query(`SELECT md5(regexp_replace(regexp_replace(
      pg_get_functiondef(p.oid), E'--[^\\r\\n]*', '', 'g'), '[[:space:]]+', '', 'g')) AS hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='update_payment_atomic'
      AND pg_get_function_identity_arguments(p.oid)='p_company_id uuid, p_payment_id uuid, p_patch jsonb'`);
  return rows[0]?.hash as string;
}

async function aclFingerprint(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC'
      ELSE x.grantee::regrole::text END || ':' || x.privilege_type AS item
    FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.update_payment_atomic(uuid,uuid,jsonb)'::regprocedure
    ORDER BY 1`);
  return rows.map((row: { item: string }) => row.item);
}

async function run088(failingLedger = false) {
  const dir = mkdtempSync(join(tmpdir(), "mig088-"));
  const sql = readFileSync(join(ROOT, "supabase/migrations", FILE), "utf8");
  writeFileSync(join(dir, FILE), sql, "utf8");
  const client = failingLedger
    ? { query: (text: unknown, params?: unknown[]) => {
        if (typeof text === "string" && text.includes("INSERT INTO public._migrations")) {
          return Promise.reject(new Error("LEDGER_088_FORCED_FAILURE"));
        }
        return pool.query(text as string, params);
      } }
    : pool;
  return runMigrations({
    client,
    migrationsDir: dir,
    rootDir: dir,
    apply: true,
    log: () => {}, logWarn: () => {}, logError: () => {},
  });
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker(["run", "--rm", "-d", "--name", CONTAINER, "--memory=384m", "--memory-swap=384m", "--cpus=0.5", "--shm-size=32m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=atomic", "-p", "127.0.0.1::5432", "postgres:17-alpine", "-c", "shared_buffers=8MB", "-c", "max_connections=10", "-c", "work_mem=1MB", "-c", "maintenance_work_mem=8MB"]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "atomic", max: 1 });
}, 180_000);

beforeEach(async () => { await applyPrestate(); });

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("088 — runner e prestate", () => {
  it("happy path aplica a função nova, ACL e proveniência", async () => {
    expect(await functionFingerprint()).toBe(PRESTATE_HASH);
    expect(await aclFingerprint()).toEqual(["postgres:EXECUTE", "service_role:EXECUTE"]);
    expect((await run088()).exitCode).toBe(0);
    expect(await functionFingerprint()).toBe(POSTSTATE_HASH);
    expect(await aclFingerprint()).toEqual(["postgres:EXECUTE", "service_role:EXECUTE"]);
    const { rows } = await pool.query("SELECT checksum FROM public._migrations WHERE name=$1", [FILE]);
    expect(rows[0]?.checksum).toBe(checksumForNewMigration(readFileSync(join(ROOT, "supabase/migrations", FILE), "utf8")));
  });

  it("falha exclusiva do ledger faz rollback total", async () => {
    const beforeAcl = await aclFingerprint();
    expect((await run088(true)).exitCode).not.toBe(0);
    expect(await functionFingerprint()).toBe(PRESTATE_HASH);
    expect(await aclFingerprint()).toEqual(beforeAcl);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public._migrations WHERE name=$1", [FILE]);
    expect(rows[0].n).toBe(0);
  });

  it("rollback aceita apenas o pós-estado 088 e restaura função + ACL", async () => {
    expect((await run088()).exitCode).toBe(0);
    const rollback = readFileSync(join(ROOT, "supabase/migrations/rollback/088_payment_competence_idempotent_edit.down.sql"), "utf8");
    await pool.query(rollback);
    expect(await functionFingerprint()).toBe(PRESTATE_HASH);
    expect(await aclFingerprint()).toEqual(["postgres:EXECUTE", "service_role:EXECUTE"]);
  });

  it("corpo adulterado, SECURITY DEFINER, ACL e overload falham fechado", async () => {
    await pool.query("CREATE OR REPLACE FUNCTION public.update_payment_atomic(p_company_id uuid, p_payment_id uuid, p_patch jsonb) RETURNS TABLE(payment_id uuid, valor_alterou boolean) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN QUERY SELECT p_payment_id, false; END $$");
    expect((await run088()).exitCode).not.toBe(0);
    await applyPrestate();
    await pool.query("REVOKE EXECUTE ON FUNCTION public.update_payment_atomic(uuid,uuid,jsonb) FROM service_role");
    expect((await run088()).exitCode).not.toBe(0);
    await applyPrestate();
    await pool.query("CREATE FUNCTION public.update_payment_atomic(uuid,uuid,jsonb,text) RETURNS TABLE(payment_id uuid, valor_alterou boolean) LANGUAGE sql AS $$ SELECT $2, false $$");
    expect((await run088()).exitCode).not.toBe(0);
  });
});
