import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `codex-collaborator-${process.pid}`;
const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
let port = 0;
let pool: pg.Pool;

const forward = fs.readFileSync(
  path.join(ROOT, "supabase/migration-drafts/collaborator_optional_auth.sql"), "utf8",
);
const rollback = fs.readFileSync(
  path.join(ROOT, "supabase/migration-drafts/rollback/collaborator_optional_auth.down.sql"), "utf8",
);

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "collaborator" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* not connected */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL 16 descartavel nao iniciou.");
}

const BASELINE = `
  DROP SCHEMA IF EXISTS storage CASCADE;
  DROP SCHEMA IF EXISTS auth CASCADE;
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA auth;
  CREATE SCHEMA storage;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
  END $$;

  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
  $$;

  CREATE TABLE public.companies (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    full_name text NOT NULL,
    email text,
    phone text,
    role text NOT NULL DEFAULT 'colaborador',
    status text NOT NULL DEFAULT 'ativo',
    contracted_hours_month numeric NOT NULL DEFAULT 168,
    skills text[] NOT NULL DEFAULT '{}',
    nif text,
    iban text,
    hourly_rate numeric,
    contract_start date,
    contract_end date
  );
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT company_id FROM public.profiles WHERE id=auth.uid() LIMIT 1
  $$;
  CREATE FUNCTION public.get_my_role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT role FROM public.profiles WHERE id=auth.uid() LIMIT 1
  $$;

  CREATE TABLE public.services (id uuid PRIMARY KEY, company_id uuid, team_id uuid);
  CREATE TABLE public.team_members (team_id uuid, collaborator_id uuid, left_at timestamptz);
  CREATE TABLE public.service_reinforcements (service_id uuid, collaborator_id uuid);
  CREATE TABLE public.timesheets (collaborator_id uuid);
  CREATE TABLE public.absences (collaborator_id uuid);
  CREATE TABLE public.vacation_requests (collaborator_id uuid, company_id uuid);
  CREATE TABLE public.payroll_records (collaborator_id uuid);
  CREATE TABLE public.notifications (user_id uuid);
  CREATE TABLE public.push_subscriptions (user_id uuid);
  CREATE TABLE public.collaborator_documents (
    collaborator_id uuid, visible_to_collaborator boolean, category text, uploaded_by_role text
  );
  CREATE TABLE public.service_photos (collaborator_id uuid);
  CREATE TABLE public.daily_clocks (collaborator_id uuid);
  CREATE TABLE public.platform_admins (profile_id uuid);
  CREATE TABLE public.app_notice_reads (profile_id uuid);
  CREATE TABLE storage.objects (bucket_id text, name text);
  CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT string_to_array($1, '/')
  $$;

  INSERT INTO public.companies(id) VALUES ('${COMPANY}');
  INSERT INTO auth.users(id) VALUES ('${AUTH_ID}');
  INSERT INTO public.profiles(id,company_id,full_name,role)
    VALUES ('${AUTH_ID}','${COMPANY}','Administrador','admin');
`;

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=collaborator",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "collaborator" });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

beforeEach(async () => {
  await pool.query(BASELINE);
});

describe.sequential("draft collaborator_optional_auth em PostgreSQL 16", () => {
  it("reproduz o schema antigo: perfil sem auth user e recusado", async () => {
    await expect(pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES(gen_random_uuid(),$1,'Ana')",
      [COMPANY],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("aplica o draft, preserva o perfil atual e permite name-only", async () => {
    await pool.query(forward);
    const old = await pool.query("SELECT auth_user_id FROM profiles WHERE id=$1", [AUTH_ID]);
    expect(old.rows[0].auth_user_id).toBe(AUTH_ID);

    const created = await pool.query(
      "INSERT INTO profiles(company_id,full_name) VALUES($1,'Ana') RETURNING *", [COMPANY],
    );
    expect(created.rows[0]).toMatchObject({
      full_name: "Ana", email: null, phone: null, nif: null, iban: null,
      auth_user_id: null,
    });
  });

  it("permite nomes iguais e multiplos opcionais NULL", async () => {
    await pool.query(forward);
    await pool.query("INSERT INTO profiles(company_id,full_name) VALUES($1,'Ana'),($1,'Ana')", [COMPANY]);
    const count = await pool.query("SELECT count(*)::int n FROM profiles WHERE full_name='Ana'");
    expect(count.rows[0].n).toBe(2);
  });

  it("mantem auth_user_id unico", async () => {
    await pool.query(forward);
    await expect(pool.query(
      "INSERT INTO profiles(company_id,full_name,auth_user_id) VALUES($1,'Outra',$2)",
      [COMPANY, AUTH_ID],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("resolve perfil, empresa e role pela conta Auth ligada", async () => {
    await pool.query(forward);
    await pool.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [AUTH_ID]);
    const result = await pool.query(
      "SELECT get_my_profile_id() profile_id,get_my_company_id() company_id,get_my_role() role",
    );
    expect(result.rows[0]).toEqual({ profile_id: AUTH_ID, company_id: COMPANY, role: "admin" });
  });

  it("RLS usa profile.id ligado e nao o auth.uid como collaborator_id", async () => {
    await pool.query(forward);
    const authId = "33333333-3333-4333-8333-333333333333";
    const profileId = "44444444-4444-4444-8444-444444444444";
    const otherProfile = "55555555-5555-4555-8555-555555555555";
    await pool.query("INSERT INTO auth.users(id) VALUES($1)", [authId]);
    await pool.query(
      "INSERT INTO profiles(id,company_id,full_name,auth_user_id) VALUES($1,$2,'Ana',$3),($4,$2,'Outra',NULL)",
      [profileId, COMPANY, authId, otherProfile],
    );
    await pool.query("INSERT INTO timesheets(collaborator_id) VALUES($1),($2)", [profileId, otherProfile]);
    await pool.query("ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY");
    await pool.query("GRANT USAGE ON SCHEMA public,auth TO authenticated");
    await pool.query("GRANT SELECT ON profiles,timesheets TO authenticated");
    await pool.query("GRANT EXECUTE ON FUNCTION auth.uid(),public.get_my_profile_id() TO authenticated");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [authId]);
      const visible = await client.query("SELECT collaborator_id FROM timesheets");
      expect(visible.rows).toEqual([{ collaborator_id: profileId }]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rollback restaura a definicao antiga quando nao existem perfis soltos", async () => {
    await pool.query(forward);
    await pool.query(rollback);
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles'",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("auth_user_id");
    await expect(pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES(gen_random_uuid(),$1,'Ana')", [COMPANY],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("rollback recusa perda de um perfil name-only", async () => {
    await pool.query(forward);
    await pool.query("INSERT INTO profiles(company_id,full_name) VALUES($1,'Ana')", [COMPANY]);
    await expect(pool.query(rollback)).rejects.toThrow(/COLLABORATOR_AUTH_DECOUPLING_ROLLBACK_BLOCKED/);
    const count = await pool.query("SELECT count(*)::int n FROM profiles WHERE full_name='Ana'");
    expect(count.rows[0].n).toBe(1);
  });
});
