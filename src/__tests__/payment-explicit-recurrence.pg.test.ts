import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const ROOT = process.cwd();
const FILE = "089_payment_explicit_recurrence.sql";
const CONTAINER = `rec089-${process.pid}`;
let port = 0;
let pool: pg.Pool;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_PAYMENT = "10000000-0000-4000-8000-000000000001";
const OTHER_PAYMENT = "20000000-0000-4000-8000-000000000001";
const NON_RECURRING_PAYMENT = "10000000-0000-4000-8000-000000000002";

const docker = (args: string[]) => spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });

function pgDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

async function waitForPostgres() {
  for (let i = 0; i < 180; i++) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "recurrence"]).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("PostgreSQL 17 não ficou pronto.");
}

async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE public._migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public._migrations(name, checksum) VALUES ('088_payment_competence_idempotent_edit.sql','prestate');
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      kind text NOT NULL,
      description text NOT NULL,
      amount numeric,
      due_date date,
      direct_debit boolean,
      status text NOT NULL DEFAULT 'pendente',
      recurring boolean NOT NULL DEFAULT false,
      period_year integer NOT NULL,
      period_month integer NOT NULL,
      paid_at timestamptz,
      notes text,
      sort_order integer DEFAULT 0,
      source_id uuid,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      expense_category_id uuid
    );
    INSERT INTO public.fixed_variable_payments(
      id, company_id, kind, description, amount, due_date, recurring,
      period_year, period_month, created_by
    ) VALUES
      ('${ROOT_PAYMENT}', '${COMPANY}', 'fixo', 'Renda', 100, '2026-08-31', true, 2026, 8, '${ACTOR}'),
      ('${OTHER_PAYMENT}', '${OTHER_COMPANY}', 'fixo', 'Outra renda', 80, '2026-08-31', true, 2026, 8, '${ACTOR}'),
      ('${NON_RECURRING_PAYMENT}', '${COMPANY}', 'variavel', 'Compra única', 25, '2026-08-31', false, 2026, 8, '${ACTOR}');
  `);
}

async function run089(failLedger = false) {
  const dir = mkdtempSync(join(tmpdir(), "rec089-"));
  const sql = readFileSync(join(ROOT, "supabase/migrations", FILE), "utf8");
  writeFileSync(join(dir, FILE), sql, "utf8");
  const db = await pool.connect();
  try {
    const client = failLedger
      ? {
          query: (text: unknown, params?: unknown[]) => {
            if (typeof text === "string" && text.includes("INSERT INTO public._migrations")) {
              return Promise.reject(new Error("LEDGER_089_FORCED_FAILURE"));
            }
            return db.query(text as string, params);
          },
        }
      : db;
    return await runMigrations({
      client,
      migrationsDir: dir,
      rootDir: dir,
      apply: true,
      log: () => {}, logWarn: () => {}, logError: () => {},
    });
  } finally {
    db.release();
  }
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "--memory=512m", "--memory-swap=512m", "--cpus=1", "--shm-size=64m",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=recurrence",
    "-p", "127.0.0.1::5432", "postgres:17-alpine",
    "-c", "shared_buffers=16MB", "-c", "max_connections=20",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "recurrence", max: 6 });
  await pool.query(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
}, 180_000);

beforeEach(async () => { await baseline(); });

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("089 — recorrência explícita", () => {
  it("runner grava ledger e legado nasce UNKNOWN sem inferência", async () => {
    expect((await run089()).exitCode).toBe(0);
    const state = await pool.query("SELECT recurrence_state FROM public.fixed_variable_payments WHERE id=$1", [ROOT_PAYMENT]);
    expect(state.rows[0].recurrence_state).toBe("LEGACY_RECURRENCE_UNKNOWN");
    const ledger = await pool.query("SELECT checksum FROM public._migrations WHERE name=$1", [FILE]);
    expect(ledger.rows[0].checksum).toBe(checksumForNewMigration(readFileSync(join(ROOT, "supabase/migrations", FILE), "utf8")));
  });

  it("distingue NOT_RECURRING e mantém isolamento por company", async () => {
    expect((await run089()).exitCode).toBe(0);
    const states = await pool.query("SELECT id, recurrence_state FROM public.fixed_variable_payments WHERE id IN ($1, $2) ORDER BY id", [ROOT_PAYMENT, NON_RECURRING_PAYMENT]);
    expect(states.rows).toEqual([
      { id: ROOT_PAYMENT, recurrence_state: "LEGACY_RECURRENCE_UNKNOWN" },
      { id: NON_RECURRING_PAYMENT, recurrence_state: "NOT_RECURRING" },
    ]);
    await pool.query("UPDATE public.fixed_variable_payments SET recurrence_interval_months=1, recurrence_anchor_date='2026-08-31' WHERE id IN ($1, $2)", [ROOT_PAYMENT, OTHER_PAYMENT]);
    const made = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,9,$2)", [COMPANY, ACTOR]);
    expect(made.rows).toHaveLength(1);
    const otherCompany = await pool.query("SELECT count(*)::int AS n FROM public.fixed_variable_payments WHERE company_id=$1 AND period_year=2026 AND period_month=9", [OTHER_COMPANY]);
    expect(otherCompany.rows[0].n).toBe(0);
  });

  it("mensal respeita dia âncora e clamp do fim do mês", async () => {
    expect((await run089()).exitCode).toBe(0);
    await pool.query("UPDATE public.fixed_variable_payments SET recurrence_interval_months=1, recurrence_anchor_date='2026-08-31' WHERE id=$1", [ROOT_PAYMENT]);
    const made = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,9,$2)", [COMPANY, ACTOR]);
    expect(made.rows).toHaveLength(1);
    expect(pgDate(made.rows[0].due_date)).toBe("2026-09-30");
  });

  it("trimestral só cai no mês correto e atravessa o ano", async () => {
    expect((await run089()).exitCode).toBe(0);
    await pool.query("UPDATE public.fixed_variable_payments SET recurrence_interval_months=3, recurrence_anchor_date='2026-08-31' WHERE id=$1", [ROOT_PAYMENT]);
    expect((await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,10,$2)", [COMPANY, ACTOR])).rows).toHaveLength(0);
    const nov = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,11,$2)", [COMPANY, ACTOR]);
    expect(nov.rows).toHaveLength(1);
    expect(pgDate(nov.rows[0].due_date)).toBe("2026-11-30");
    const fev = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2027,2,$2)", [COMPANY, ACTOR]);
    expect(fev.rows).toHaveLength(1);
    expect(pgDate(fev.rows[0].due_date)).toBe("2027-02-28");
  });

  it("duplo clique e concorrência são idempotentes", async () => {
    expect((await run089()).exitCode).toBe(0);
    await pool.query("UPDATE public.fixed_variable_payments SET recurrence_interval_months=1, recurrence_anchor_date='2026-08-31' WHERE id=$1", [ROOT_PAYMENT]);
    const [a, b] = await Promise.all([
      pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,9,$2)", [COMPANY, ACTOR]),
      pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,9,$2)", [COMPANY, ACTOR]),
    ]);
    expect(a.rows.length + b.rows.length).toBe(1);
    const count = await pool.query("SELECT count(*)::int AS n FROM public.fixed_variable_payments WHERE source_id=$1 AND period_year=2026 AND period_month=9", [ROOT_PAYMENT]);
    expect(count.rows[0].n).toBe(1);
  });

  it("linhas materializadas não voltam a candidatar-se", async () => {
    expect((await run089()).exitCode).toBe(0);
    await pool.query("UPDATE public.fixed_variable_payments SET recurrence_interval_months=1, recurrence_anchor_date='2026-08-31' WHERE id=$1", [ROOT_PAYMENT]);
    const september = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,9,$2)", [COMPANY, ACTOR]);
    const october = await pool.query("SELECT * FROM public.prepare_recurring_payments_month_atomic($1,2026,10,$2)", [COMPANY, ACTOR]);
    expect(september.rows).toHaveLength(1);
    expect(october.rows).toHaveLength(1);
    const count = await pool.query("SELECT count(*)::int AS n FROM public.fixed_variable_payments WHERE source_id=$1", [ROOT_PAYMENT]);
    expect(count.rows[0].n).toBe(2);
  });

  it("falha exclusiva do ledger reverte schema e função", async () => {
    expect((await run089(true)).exitCode).not.toBe(0);
    const cols = await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='fixed_variable_payments' AND column_name LIKE 'recurrence_%'");
    expect(cols.rows[0].n).toBe(0);
    const fn = await pool.query("SELECT to_regprocedure('public.prepare_recurring_payments_month_atomic(uuid,integer,integer,uuid)') IS NOT NULL AS present");
    expect(fn.rows[0].present).toBe(false);
    const ledger = await pool.query("SELECT count(*)::int AS n FROM public._migrations WHERE name=$1", [FILE]);
    expect(ledger.rows[0].n).toBe(0);
  });
});
