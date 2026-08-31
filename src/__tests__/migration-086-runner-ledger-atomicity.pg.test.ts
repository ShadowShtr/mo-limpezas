/**
 * 086 — atomicidade entre EFEITO DE SCHEMA e PROVENIÊNCIA NO LEDGER.
 *
 * A suite principal da 086 aplica o `.sql` directamente sobre uma baseline
 * mínima. Isso prova o que a migration faz; não prova a metade que a onda
 * 077→085 existe para garantir:
 *
 *     BEGIN → executar o .sql → INSERT public._migrations → COMMIT
 *
 * Se o INSERT do ledger falhar, TODO o efeito de schema tem de desaparecer.
 * Uma migration com `BEGIN;`/`COMMIT;` próprios fecha a transação do runner a
 * meio, o efeito fica commitado, e o `ROLLBACK` do catch vira no-op —
 * `SCHEMA_EFFECT = YES` com `MIGRATION_PROVENANCE = NO`.
 *
 * 🔴 A 086 é o caso mais exigente desta frente até hoje, porque não cria só
 *    objectos novos. Ela também:
 *
 *      · SUBSTITUI um CHECK que já existe (`cash_flow_entries`);
 *      · faz `CREATE OR REPLACE` de uma função da 062.
 *
 *    «A tabela desapareceu» não chega como prova de reversão. Um `ROLLBACK`
 *    que devolvesse a tabela mas deixasse o CHECK novo — ou a função com a
 *    guarda financeira — teria revertido metade. Este ficheiro mede as quatro
 *    superfícies, e o `md5(pg_get_functiondef(...))` distingue a versão da
 *    função, coisa que a mera existência não faz.
 *
 * Corre o runner REAL, contra PostgreSQL 17 em Docker, com um cliente que
 * intercepta apenas o INSERT no ledger.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";

const ROOT = process.cwd();
const CONTAINER = `mig086-${process.pid}`;
const M086 = "086_manual_charges_and_atomic_billing.sql";
let port = 0;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const silencio = { log: () => {}, logWarn: () => {}, logError: () => {} };

/**
 * O prestate que a 086 encontra em produção: a 024 (índice parcial), a 075
 * (CHECK com quatro tipos) e a 062 (`delete_calendar_service_safe` sem guarda
 * financeira). É o mesmo desenho da suite principal — se as duas baselines
 * divergirem, uma delas passa a falar de um sistema que não existe.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $p$;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $a$ SELECT NULL::uuid $a$;
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, role text);
  CREATE TABLE public.clients (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
  CREATE TABLE public.company_settings (
    company_id uuid PRIMARY KEY, vat_rate numeric DEFAULT 23);
  CREATE TABLE public.contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text DEFAULT 'ativo', fixed_monthly boolean DEFAULT false,
    fixed_price numeric, apply_vat boolean DEFAULT true,
    excluded_dates date[] DEFAULT '{}');
  CREATE TABLE public.services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    contract_id uuid, location_id uuid, reference_number text,
    scheduled_start timestamptz NOT NULL, status text DEFAULT 'agendado',
    manual_value numeric, calculated_value numeric, apply_vat boolean DEFAULT true,
    payment_status text DEFAULT 'nao_informado', paid_amount numeric,
    paid_at timestamptz);
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')),
    amount numeric(10,2) NOT NULL, description text NOT NULL,
    category text DEFAULT 'outro', date date NOT NULL,
    reference_id uuid, reference_type text,
    status text NOT NULL DEFAULT 'confirmado',
    notes text, created_by uuid, created_at timestamptz DEFAULT now(),
    expense_category_id uuid);
  CREATE TABLE public.data_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text, row_id uuid,
    op text, old_data jsonb, new_data jsonb, actor uuid, company_id uuid,
    changed_fields text[], created_at timestamptz DEFAULT now());

  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries (company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

  ALTER TABLE public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN
      ('invoice','payroll','service_payment','fixed_variable_payment'));

  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $g$ SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $g$;
  CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $r$ SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;

  CREATE OR REPLACE FUNCTION public.fn_capture_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $h$
  BEGIN RETURN NEW; END $h$;

  -- A 062, sem guarda financeira: é esta versão que a 086 substitui, e é a
  -- esta que um ROLLBACK tem de voltar.
  CREATE OR REPLACE FUNCTION public.delete_calendar_service_safe(
    p_service_id uuid, p_scope text, p_company_id uuid, p_actor uuid DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $d$
  DECLARE v_deleted int := 0;
  BEGIN
    DELETE FROM public.services WHERE id = p_service_id AND company_id = p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_deleted, 'recurring', false);
  END $d$;
`;

async function esperar() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "atomic"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const up = docker(["run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=atomic",
    "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  if (up.status !== 0) throw new Error(up.stderr || up.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await esperar();
}, 180_000);

afterAll(() => {
  docker(["rm", "-f", CONTAINER]);
});

/** Cliente que deixa passar tudo excepto o INSERT no ledger. */
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

async function preparar() {
  const dir = mkdtempSync(join(tmpdir(), "mig086-"));
  writeFileSync(join(dir, M086), readFileSync(join(ROOT, "supabase", "migrations", M086), "utf8"));
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
  await client.connect();
  await client.query(BASELINE);
  return { dir, client };
}

// ─── As quatro superfícies que a 086 toca ───────────────────────────────────

async function tabelaExiste(c: pg.Client, nome: string) {
  const { rows } = await c.query("SELECT to_regclass($1) AS reg", [nome]);
  return rows[0].reg !== null;
}

async function funcoesExistentes(c: pg.Client) {
  const { rows } = await c.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
    [["set_service_payment_atomic", "set_manual_charge_payment_atomic",
      "void_manual_charge_atomic", "update_manual_charge_atomic"]],
  );
  return new Set(rows.map((r: { proname: string }) => r.proname));
}

/** O CHECK aceita `manual_charge`? Pergunta-se ao catálogo, não ao texto. */
async function checkAceitaManualCharge(c: pg.Client) {
  const { rows } = await c.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid = 'public.cash_flow_entries'::regclass
        AND conname  = 'cash_flow_entries_reference_type_check'`);
  return rows.length > 0 && String(rows[0].d).includes("manual_charge");
}

/**
 * 🔴 A sonda certa para um `CREATE OR REPLACE`: o TEXTO instalado, não a
 *    existência. A função já existia antes da 086 — «existe» não distingue a
 *    versão da 062 da versão com guarda financeira.
 */
async function deleteTemGuardaFinanceira(c: pg.Client) {
  const { rows } = await c.query(
    `SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'delete_calendar_service_safe'`);
  return rows.length > 0 && String(rows[0].d).includes("SERVICE_DELETE_BLOCKED_BY_PAYMENT");
}

async function ledgerNomes(c: pg.Client) {
  const existe = await c.query("SELECT to_regclass('public._migrations') AS reg");
  if (!existe.rows[0].reg) return [];
  const { rows } = await c.query("SELECT name FROM public._migrations ORDER BY name");
  return rows.map((r: { name: string }) => r.name);
}

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("086 — atomicidade schema ↔ ledger no runner real", () => {
  it("🔴 corre em PostgreSQL 17, perguntado ao servidor", async () => {
    const { client } = await preparar();
    const { rows } = await client.query("SELECT version() AS v");
    expect(rows[0].v).toMatch(/^PostgreSQL 17\./);
    await client.end();
  }, 120_000);

  it("o ficheiro não abre nem fecha transação própria — a transação é do runner", () => {
    const linhas = readFileSync(join(ROOT, "supabase", "migrations", M086), "utf8")
      .split("\n").map((l) => l.trim());
    expect(linhas.filter((l) => l === "BEGIN;")).toHaveLength(0);
    expect(linhas.filter((l) => l === "COMMIT;")).toHaveLength(0);
  });

  it("🔴 caminho feliz: as QUATRO superfícies e o ledger commitam juntos", async () => {
    const { dir, client } = await preparar();
    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(0);

    expect(await tabelaExiste(client, "public.manual_charges")).toBe(true);
    expect(await funcoesExistentes(client)).toEqual(new Set([
      "set_service_payment_atomic", "set_manual_charge_payment_atomic",
      "void_manual_charge_atomic", "update_manual_charge_atomic",
    ]));
    expect(await checkAceitaManualCharge(client)).toBe(true);
    expect(await deleteTemGuardaFinanceira(client)).toBe(true);
    expect(await ledgerNomes(client)).toContain(M086);

    await client.end();
  }, 180_000);

  it("🔴 ADVERSARIAL: o INSERT no ledger falha ⇒ TUDO reverte", async () => {
    const { dir, client } = await preparar();

    const { exitCode } = await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(1);

    // 1. A tabela nova não sobreviveu.
    expect(await tabelaExiste(client, "public.manual_charges")).toBe(false);

    // 2. Nenhuma das funções novas sobreviveu.
    expect(await funcoesExistentes(client)).toEqual(new Set());

    // 3. 🔴 O CHECK voltou ao da 075. Esta é a superfície que uma reversão
    //    parcial deixaria para trás: a 086 fez DROP + ADD, e se o ROLLBACK
    //    não cobrisse os dois, `manual_charge` ficaria aceite sem nada que o
    //    escrevesse — ou, pior, o CHECK ficaria em falta.
    expect(await checkAceitaManualCharge(client)).toBe(false);
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid = 'public.cash_flow_entries'::regclass
          AND conname  = 'cash_flow_entries_reference_type_check'`);
    expect(rows[0].n, "o CHECK da 075 tem de continuar lá").toBe(1);

    // 4. 🔴 A função da 062 voltou à versão SEM guarda financeira. «Existe»
    //    não provaria nada: ela existia antes.
    expect(await deleteTemGuardaFinanceira(client)).toBe(false);
    const { rows: def } = await client.query(
      `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='delete_calendar_service_safe'`);
    expect(def[0].n, "a função da 062 tem de continuar lá").toBe(1);

    // 5. E o ledger não ganhou a 086.
    expect(await ledgerNomes(client)).not.toContain(M086);

    await client.end();
  }, 180_000);

  it("🔴 e o prestate revertido ainda ACEITA a 086 — a reversão é completa, não aproximada", async () => {
    // O teste anterior mede ausências. Este mede a consequência: se o
    // ROLLBACK tivesse deixado qualquer coisa para trás, as precondições
    // fail-closed da secção 0 recusariam a segunda tentativa. Correr a
    // migration outra vez, com sucesso, é a prova de que o prestate é mesmo
    // o prestate.
    const { dir, client } = await preparar();

    expect((await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    })).exitCode).toBe(1);

    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(0);
    expect(await tabelaExiste(client, "public.manual_charges")).toBe(true);
    expect(await checkAceitaManualCharge(client)).toBe(true);
    expect(await deleteTemGuardaFinanceira(client)).toBe(true);
    expect(await ledgerNomes(client)).toContain(M086);

    await client.end();
  }, 180_000);
});
