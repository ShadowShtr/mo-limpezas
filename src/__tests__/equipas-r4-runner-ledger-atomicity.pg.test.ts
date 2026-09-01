import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const ROOT = process.cwd();
const CONTAINER = `equipasr4-${process.pid}`;
const SOURCE = join(ROOT, "supabase", "migrations", "087_equipas_r4.sql");
const REHEARSAL_NAME = "087_equipas_r4.sql";
let port = 0;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const silencio = { log: () => {}, logWarn: () => {}, logError: () => {} };

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $p$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, full_name text NOT NULL,
    role text DEFAULT 'colaborador', status text DEFAULT 'ativo', avatar_url text, phone text);
  CREATE TABLE public.teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name text NOT NULL, color text DEFAULT '#16A34A',
    leader_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at date DEFAULT CURRENT_DATE,
    left_at date,
    CONSTRAINT team_members_team_id_collaborator_id_key UNIQUE (team_id, collaborator_id));
  CREATE TABLE public.vehicles (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, model text, plate text, status text DEFAULT 'ativo');
  CREATE TABLE public.vehicle_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vehicle_allocations_vehicle_date_unique UNIQUE (vehicle_id, date));
  CREATE TABLE public.collaborator_ride_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    date date NOT NULL,
    assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT collaborator_ride_collaborator_date_unique UNIQUE (collaborator_id, date));
  CREATE TABLE public.absences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL, collaborator_id uuid NOT NULL,
    absence_type text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL);
  CREATE VIEW public.teams_with_members AS
  SELECT t.id, t.company_id, t.name, t.color, t.active, t.leader_id,
    COALESCE(json_agg(json_build_object('id', p.id, 'full_name', p.full_name,
      'avatar_url', p.avatar_url, 'phone', p.phone))
      FILTER (WHERE p.id IS NOT NULL), '[]') AS members
  FROM public.teams t
  LEFT JOIN public.team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
  LEFT JOIN public.profiles p ON p.id = tm.collaborator_id
  GROUP BY t.id, t.company_id, t.name, t.color, t.active, t.leader_id;
`;

async function esperar() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "equipasr4"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "equipasr4" });
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
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=equipasr4",
    "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  if (up.status !== 0) throw new Error(up.stderr || up.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await esperar();
}, 180_000);

afterAll(() => {
  docker(["rm", "-f", CONTAINER]);
});

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

async function preparar({ ledger086 }: { ledger086: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "equipasr4-"));
  writeFileSync(join(dir, REHEARSAL_NAME), readFileSync(SOURCE, "utf8"));
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "equipasr4" });
  await client.connect();
  await client.query(BASELINE);
  if (ledger086) {
    await client.query(
      "INSERT INTO public._migrations(name, checksum) VALUES('086_manual_charges_and_atomic_billing.sql','test-086')");
  }
  return { dir, client };
}

async function schemaEffect(c: pg.Client) {
  const { rows } = await c.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='teams' AND column_name='revision') AS revision,
      to_regclass('public.team_members_one_active_per_collaborator') AS active_idx,
      to_regprocedure('public.save_team_day_allocations_atomic(uuid,date,uuid,text,jsonb,jsonb)') AS save_day,
      to_regprocedure('public.archive_team_atomic(uuid,uuid,uuid,integer,text)') AS archive
  `);
  return rows[0] as { revision: number; active_idx: string | null; save_day: string | null; archive: string | null };
}

async function ledgerNomes(c: pg.Client) {
  const { rows } = await c.query("SELECT name, checksum FROM public._migrations ORDER BY name");
  return rows as Array<{ name: string; checksum: string }>;
}

describe.sequential("087 Equipas R4 — runner/ledger/schema atomicidade", () => {
  it("A. corre em PostgreSQL 17 real", async () => {
    const { client } = await preparar({ ledger086: true });
    expect((await client.query("SELECT version() AS v")).rows[0].v).toMatch(/^PostgreSQL 17\./);
    await client.end();
  }, 120_000);

  it("B. o ficheiro não abre nem fecha transação própria", () => {
    const linhas = readFileSync(SOURCE, "utf8")
      .split("\n").map((l) => l.trim());
    expect(linhas.filter((l) => l === "BEGIN;")).toHaveLength(0);
    expect(linhas.filter((l) => l === "COMMIT;")).toHaveLength(0);
  });

  it("C. schema semelhante sem ledger 086 é recusado", async () => {
    const { dir, client } = await preparar({ ledger086: false });
    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(1);
    expect(await schemaEffect(client)).toMatchObject({ revision: 0, active_idx: null, save_day: null, archive: null });
    expect(await ledgerNomes(client)).toEqual([]);
    await client.end();
  }, 180_000);

  it("D. caminho feliz: schema e ledger do rehearsal commitam juntos com checksum canónico", async () => {
    const { dir, client } = await preparar({ ledger086: true });
    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);
    expect(await schemaEffect(client)).toMatchObject({
      revision: 1,
      active_idx: "team_members_one_active_per_collaborator",
      save_day: "save_team_day_allocations_atomic(uuid,date,uuid,text,jsonb,jsonb)",
      archive: "archive_team_atomic(uuid,uuid,uuid,integer,text)",
    });
    const ledger = await ledgerNomes(client);
    expect(ledger.find((r) => r.name === REHEARSAL_NAME)?.checksum)
      .toBe(checksumForNewMigration(readFileSync(SOURCE, "utf8")));
    await client.end();
  }, 180_000);

  it("E-H. ledger insert falha: todo schema R4 reverte e a repetição limpa passa", async () => {
    const { dir, client } = await preparar({ ledger086: true });
    expect((await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir,
      rootDir: ROOT,
      apply: true,
      ...silencio,
    })).exitCode).toBe(1);

    expect(await schemaEffect(client)).toMatchObject({ revision: 0, active_idx: null, save_day: null, archive: null });
    expect((await ledgerNomes(client)).map((r) => r.name)).not.toContain(REHEARSAL_NAME);

    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);
    expect((await ledgerNomes(client)).map((r) => r.name)).toContain(REHEARSAL_NAME);
    await client.end();
  }, 180_000);
});
