/**
 * PHASE C, lote 2 — os dados pessoais de cada pessoa.
 *
 * Estas políticas diziam `collaborator_id = auth.uid()`. `collaborator_id` é
 * uma chave estrangeira para `profiles(id)` — o id de **uma pessoa**;
 * `auth.uid()` é o id de **uma sessão**. Enquanto os dois eram forçosamente o
 * mesmo número, comparar um com o outro estava certo. O EXPAND acabou com essa
 * garantia, e o que estas políticas protegem são as horas de trabalho, o
 * recibo de vencimento, as faltas e o registo de ponto de cada pessoa.
 *
 * Cada tabela tem dois testes: o que era permitido continua permitido, e um
 * token forjado com o id de uma pessoa **sem** conta não abre nada.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `rls-lote2-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

let port = 0;
let pool: pg.Pool;
let colabA = "";
let colegaA = "";
let semConta = "";

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const EXPAND = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_expand.sql");
const LOTE1 = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_resolver_rls.sql");
const LOTE2 = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_resolver_rls_lote2.sql");
const LOTE2_DOWN = () => readSql("supabase", "migrations", "draft", "rollback",
  "PROVISIONAL_collaborator_identity_resolver_rls_lote2.down.sql");

/**
 * O esqueleto das tabelas de dados pessoais, com as colunas que as políticas
 * lêem — e `user_id` a apontar para `profiles`, apesar do nome.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA auth;

  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $rol$
    SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $rol$;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    role text NOT NULL DEFAULT 'colaborador');

  CREATE TABLE public.timesheets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    horas numeric(6,2));
  CREATE TABLE public.payroll_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    net_salary numeric(10,2));
  CREATE TABLE public.absences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    motivo text);
  CREATE TABLE public.daily_clocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    dia date);
  CREATE TABLE public.service_photos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    storage_path text);
  -- 🔴 user_id aponta para profiles, não para auth.users. O nome engana.
  CREATE TABLE public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    titulo text);
  CREATE TABLE public.push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    endpoint text);

  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $c$
    SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $c$;
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $r$
    SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "profiles_select" ON profiles
    FOR SELECT USING (id = auth.uid() OR company_id = get_my_company_id());
  CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (id = auth.uid())
    WITH CHECK (id = auth.uid() AND company_id = public.get_my_company_id());
  CREATE POLICY "profiles_manage_company" ON profiles
    FOR ALL USING (
      company_id = get_my_company_id() AND get_my_role() IN ('admin','gestor'));

  -- As formas de origem do lote 2.
  ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "collaborators see own timesheets" ON timesheets
    FOR SELECT USING (collaborator_id = auth.uid());
  CREATE POLICY "timesheets_own_select" ON timesheets
    FOR SELECT USING (collaborator_id = auth.uid());
  ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "collaborators see own payroll" ON payroll_records
    FOR SELECT USING (collaborator_id = auth.uid());
  ALTER TABLE public.absences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "absences_own_select" ON absences
    FOR SELECT USING (collaborator_id = auth.uid());
  ALTER TABLE public.daily_clocks ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "daily_clocks_own" ON daily_clocks
    FOR ALL USING (collaborator_id = auth.uid())
    WITH CHECK (collaborator_id = auth.uid());
  ALTER TABLE public.service_photos ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "service_photos_own_read" ON service_photos
    FOR SELECT USING (collaborator_id = auth.uid());
  ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "users see own notifications" ON notifications
    FOR SELECT USING (user_id = auth.uid());
  ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "users manage own push subs" ON push_subscriptions
    FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

  DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
      THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
      THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
      THEN CREATE ROLE service_role; END IF;
  END $roles$;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO authenticated, anon;
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "lote2" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

async function prepara(comLote2: boolean) {
  await pool.query(BASELINE);
  await pool.query("INSERT INTO companies VALUES($1,'A'),($2,'B')", [EMPRESA_A, EMPRESA_B]);
  const criar = async (nome: string) => {
    const id = randomUUID();
    await pool.query("INSERT INTO auth.users VALUES($1,$2)", [id, `${nome}@exemplo.pt`]);
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,$3)",
      [id, EMPRESA_A, nome]);
    return id;
  };
  colabA = await criar("colabA");
  colegaA = await criar("colegaA");

  await pool.query(EXPAND());
  await pool.query(LOTE1());
  if (comLote2) await pool.query(LOTE2());

  // Só possível depois do EXPAND: uma pessoa sem conta de acesso.
  semConta = randomUUID();
  await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
    [semConta, EMPRESA_A]);

  // Dados pessoais de cada uma das três.
  for (const [quem] of [[colabA], [colegaA], [semConta]] as const) {
    await pool.query("INSERT INTO timesheets(company_id,collaborator_id,horas) VALUES($1,$2,8)",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,1200)",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO absences(company_id,collaborator_id,motivo) VALUES($1,$2,'doença')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO daily_clocks(company_id,collaborator_id,dia) VALUES($1,$2,'2026-08-26')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO service_photos(company_id,collaborator_id,storage_path) VALUES($1,$2,'f.jpg')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO notifications(user_id,titulo) VALUES($1,'aviso')", [quem]);
    await pool.query("INSERT INTO push_subscriptions(user_id,endpoint) VALUES($1,'https://e')", [quem]);
  }
}

async function comoRest<T>(authId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "lote2" });
  await c.connect();
  try {
    await c.query("SET ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId ?? ""]);
    await c.query("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
    return await fn(c);
  } finally { await c.end(); }
}

const conta = (authId: string | null, tabela: string) =>
  comoRest(authId, async (c) =>
    Number((await c.query(`SELECT count(*)::int n FROM ${tabela}`)).rows[0].n));

const TABELAS = ["timesheets", "payroll_records", "absences", "daily_clocks",
  "service_photos", "notifications", "push_subscriptions"] as const;

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=lote2",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "lote2", max: 8 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("lote 2 — cada pessoa continua a ver só o que é seu", () => {
  it.each(TABELAS)("%s: vê o próprio registo e mais nenhum", async (tabela) => {
    await prepara(true);
    expect(await conta(colabA, tabela)).toBe(1);
    expect(await conta(colegaA, tabela)).toBe(1);
  });

  it("nenhuma tabela muda de comportamento para quem tem conta", async () => {
    await prepara(false);
    const antes: Record<string, number> = {};
    for (const t of TABELAS) antes[t] = await conta(colabA, t);
    await prepara(true);
    const depois: Record<string, number> = {};
    for (const t of TABELAS) depois[t] = await conta(colabA, t);
    expect(depois).toEqual(antes);
    // Guarda: se o cenário deixasse de medir alguma coisa, isto apanhava.
    expect(Object.values(antes).every((n) => n === 1)).toBe(true);
  });
});

describe.sequential("lote 2 — o id de uma pessoa sem conta não abre nada", () => {
  it.each(TABELAS)("🔴 %s: token forjado não devolve os dados dela", async (tabela) => {
    await prepara(true);
    expect(await conta(semConta, tabela)).toBe(0);
  });

  it("🔴 antes do lote 2, esse mesmo token via tudo — é o que isto fecha", async () => {
    await prepara(false);
    // Com `collaborator_id = auth.uid()`, o id da pessoa sem conta batia certo.
    const expostas: string[] = [];
    for (const t of TABELAS) if (await conta(semConta, t) > 0) expostas.push(t);
    expect(expostas.sort()).toEqual([...TABELAS].sort());
  });

  it("🔴 e não consegue escrever por essa via", async () => {
    await prepara(true);
    const r = await comoRest(semConta, (c) =>
      c.query("UPDATE daily_clocks SET dia='2026-01-01' WHERE collaborator_id=$1", [semConta]));
    expect(r.rowCount).toBe(0);
  });
});

describe.sequential("lote 2 — rollback", () => {
  it("repõe a forma anterior, e o comportamento com conta não muda", async () => {
    await prepara(true);
    const comLote2: Record<string, number> = {};
    for (const t of TABELAS) comLote2[t] = await conta(colabA, t);

    await pool.query(LOTE2_DOWN());

    const defs = (await pool.query(
      `SELECT qual FROM pg_policies
        WHERE tablename = ANY($1::text[]) AND policyname NOT LIKE 'profiles%'`,
      [[...TABELAS]])).rows.map((r) => r.qual).join(" ");
    expect(defs).toContain("auth.uid()");
    expect(defs).not.toContain("get_my_profile_id");

    const depois: Record<string, number> = {};
    for (const t of TABELAS) depois[t] = await conta(colabA, t);
    expect(depois).toEqual(comLote2);
  });
});
