/**
 * Atomicidade entre EFEITO DE SCHEMA e PROVENANCE NO LEDGER.
 *
 * O runner (scripts/lib/migration-runner-core.mjs) é a transação autoritativa:
 *
 *   BEGIN -> executar o .sql -> INSERT public._migrations -> COMMIT
 *
 * Uma migration que traga `BEGIN;`/`COMMIT;` próprios fecha essa transação a
 * meio. O efeito de schema fica commitado, o INSERT do ledger passa a correr
 * noutra transação implícita, e o `ROLLBACK` do catch do runner vira no-op.
 * Resultado: SCHEMA_EFFECT = YES com MIGRATION_PROVENANCE = NO.
 *
 * Este ficheiro não testa "a migration corre". Testa a metade que interessa:
 * quando o INSERT do ledger falha, o efeito de schema TEM de desaparecer.
 *
 * Corre o runner REAL — não uma reimplementação — contra Postgres 16 real em
 * Docker, com um cliente que intercepta apenas o INSERT no ledger.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";

const ROOT = process.cwd();
const CONTAINER = `mig-atomic-${process.pid}`;
let port = 0;

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

/** Schema mínimo de que 079/080/081 dependem (subconjunto da 073). */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    description text,
    amount numeric(12,2) NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pendente',
    due_date date,
    payment_date date,
    category_id uuid,
    supplier text,
    notes text);
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    description text,
    entry_date date NOT NULL DEFAULT CURRENT_DATE,
    status text NOT NULL DEFAULT 'confirmado',
    reference_type text,
    reference_id uuid,
    category_id uuid,
    notes text);
`;

async function waitForPostgres() {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch {
      try { await c.end(); } catch { /* noop */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Postgres não ficou pronto");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=atomic",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
}, 180_000);

afterAll(() => {
  docker(["rm", "-f", CONTAINER]);
});

/**
 * Cliente que deixa passar tudo excepto o INSERT no ledger, que rebenta como
 * rebentaria uma falha real (constraint, permissão, disco). É o gatilho do
 * cenário adversarial — nada mais é alterado.
 */
function clientQueFalhaNoLedger(real: pg.Client) {
  const passthrough = real as unknown as { query: (t: unknown, p?: unknown) => Promise<unknown> };
  return {
    query: (text: unknown, params?: unknown) => {
      if (typeof text === "string" && text.includes("INSERT INTO public._migrations")) {
        return Promise.reject(new Error("LEDGER_INSERT_FORCED_FAILURE"));
      }
      return passthrough.query(text, params);
    },
  };
}

/** Cada caso corre isolado: baseline limpo, dir só com as migrations pedidas. */
async function preparar(migrations: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "mig-atomic-"));
  for (const m of migrations) {
    writeFileSync(join(dir, m), readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
  await client.connect();
  await client.query(BASELINE);
  return { dir, client };
}

const silencio = { log: () => {}, logWarn: () => {}, logError: () => {} };

/** Objetos que cada migration cria — a assinatura observável do efeito de schema. */
async function funcoesExistentes(client: pg.Client, nomes: string[]) {
  const { rows } = await client.query(
    `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = ANY($1)`,
    [nomes],
  );
  return new Set(rows.map((r: { proname: string }) => r.proname));
}

async function ledgerNomes(client: pg.Client) {
  const existe = await client.query("select to_regclass('public._migrations') as reg");
  if (!existe.rows[0].reg) return [];
  const { rows } = await client.query("select name from public._migrations order by name");
  return rows.map((r: { name: string }) => r.name);
}

describe.sequential("Atomicidade schema ↔ ledger no runner", () => {
  it("079: nenhum BEGIN;/COMMIT; de topo — a transação é a do runner", () => {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"), "utf8");
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
    // ...e os corpos PL/pgSQL continuam lá: não foi um replace cego.
    expect(sql).toContain("$guard$");
    expect(sql).toContain("$fn$");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.assert_payment_cashflow_link");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.mark_payment_paid");
  });

  it("079 caminho feliz: schema E ledger commitam juntos", async () => {
    const { dir, client } = await preparar(["079_reuse_pending_cashflow_on_payment.sql"]);
    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(0);
    const fns = await funcoesExistentes(client, ["assert_payment_cashflow_link", "mark_payment_paid"]);
    expect(fns.has("assert_payment_cashflow_link")).toBe(true);
    expect(fns.has("mark_payment_paid")).toBe(true);
    expect(await ledgerNomes(client)).toContain("079_reuse_pending_cashflow_on_payment.sql");
    await client.end();
  }, 120_000);

  it("079 ADVERSARIAL: ledger INSERT falha ⇒ efeito de schema revertido", async () => {
    const { dir, client } = await preparar(["079_reuse_pending_cashflow_on_payment.sql"]);
    const antes = await funcoesExistentes(client, ["assert_payment_cashflow_link", "mark_payment_paid"]);
    expect(antes.size).toBe(0);

    const { exitCode } = await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(1);

    // 🔴 O coração da prova: sem provenance, não pode ficar efeito de schema.
    const depois = await funcoesExistentes(client, ["assert_payment_cashflow_link", "mark_payment_paid"]);
    expect(depois.has("assert_payment_cashflow_link")).toBe(false);
    expect(depois.has("mark_payment_paid")).toBe(false);
    expect(await ledgerNomes(client)).not.toContain("079_reuse_pending_cashflow_on_payment.sql");
    await client.end();
  }, 120_000);
});
