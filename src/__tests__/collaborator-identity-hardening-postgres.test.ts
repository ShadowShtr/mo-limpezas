/**
 * PHASE F — a matriz final, contra tudo o que foi construído junto.
 *
 * As fases anteriores provaram-se uma a uma. Esta aplica-as **todas ao mesmo
 * tempo** — EXPAND, resolver, lotes de RLS — e pergunta o que só se pode
 * perguntar no fim:
 *
 *   · quem já entrava continua a entrar, exactamente como entrava? (ADM01–07)
 *   · quem existe sem conta aparece onde deve, sem partir nada? (consumidores)
 *   · o ciclo inteiro — criar pessoa, dar acesso, tirar, devolver — mantém a
 *     mesma identidade do princípio ao fim?
 *
 * O incidente da #86 foi exactamente uma regressão de login que ninguém tinha
 * testado. É contra isso que a primeira secção existe.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `hardening-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

let port = 0;
let pool: pg.Pool;
let ids: Record<string, string> = {};

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const draft = (f: string) => readSql("supabase", "migrations", "draft", f);

/**
 * O esqueleto anterior a tudo: `profiles.id` a ser chave estrangeira para
 * `auth.users`, as funções da 014, e as políticas nas formas de origem.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA auth;

  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE, banned_until timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $rol$
    SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $rol$;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    phone text, email text, nif text, iban text,
    hourly_rate numeric(10,2), contract_start date,
    role text NOT NULL DEFAULT 'colaborador'
      CHECK (role IN ('admin','gestor','colaborador')),
    status text NOT NULL DEFAULT 'ativo');

  CREATE TABLE public.payroll_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    net_salary numeric(10,2));
  CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.collaborator_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    file_url text);
  CREATE TABLE public.absences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    motivo text);
  CREATE TABLE public.vacation_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.timesheets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    horas numeric(6,2));
  CREATE TABLE public.daily_clocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    dia date);
  CREATE TABLE public.service_photos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    storage_path text);
  CREATE TABLE public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, titulo text);
  CREATE TABLE public.push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, endpoint text);

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

  ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "timesheets_own_select" ON timesheets
    FOR SELECT USING (collaborator_id = auth.uid());
  CREATE POLICY "collaborators see own timesheets" ON timesheets
    FOR SELECT USING (collaborator_id = auth.uid());
  ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "collaborators see own payroll" ON payroll_records
    FOR SELECT USING (collaborator_id = auth.uid());
  CREATE POLICY "payroll_company" ON payroll_records
    FOR SELECT USING (company_id = get_my_company_id());
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
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "hard" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

/** Gente que já existia antes de tudo isto, com o seu histórico. */
async function mundoAntigo() {
  await pool.query(BASELINE);
  await pool.query("INSERT INTO companies VALUES($1,'A'),($2,'B')", [EMPRESA_A, EMPRESA_B]);
  const criar = async (empresa: string, nome: string, papel: string) => {
    const id = randomUUID();
    await pool.query("INSERT INTO auth.users VALUES($1,$2)", [id, `${nome}@exemplo.pt`]);
    await pool.query(
      `INSERT INTO profiles(id,company_id,full_name,role,email,nif,iban,hourly_rate)
       VALUES($1,$2,$3,$4,$5,'123456789','PT50000',9.5)`,
      [id, empresa, nome, papel, `${nome}@exemplo.pt`]);
    return id;
  };
  ids = {
    admin: await criar(EMPRESA_A, "admin", "admin"),
    gestor: await criar(EMPRESA_A, "gestor", "gestor"),
    colab: await criar(EMPRESA_A, "colab", "colaborador"),
    adminB: await criar(EMPRESA_B, "adminB", "admin"),
  };
  for (const quem of [ids.colab]) {
    await pool.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,1200)",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO team_members(collaborator_id) VALUES($1)", [quem]);
    await pool.query(
      "INSERT INTO collaborator_documents(collaborator_id,file_url) VALUES($1,'contrato.pdf')",
      [quem]);
    await pool.query("INSERT INTO absences(company_id,collaborator_id,motivo) VALUES($1,$2,'d')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO vacation_requests(company_id,collaborator_id) VALUES($1,$2)",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO timesheets(company_id,collaborator_id,horas) VALUES($1,$2,8)",
      [EMPRESA_A, quem]);
  }
  return ids;
}

/** Aplica tudo o que as fases A a E produziram, pela ordem em que correriam. */
async function aplicarTudo() {
  await pool.query(draft("PROVISIONAL_collaborator_identity_expand.sql"));
  await pool.query(draft("PROVISIONAL_collaborator_identity_resolver_rls.sql"));
  await pool.query(draft("PROVISIONAL_collaborator_identity_resolver_rls_lote2.sql"));
}

async function como<T>(authId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "hard" });
  await c.connect();
  try {
    await c.query("SET ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId ?? ""]);
    await c.query("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
    return await fn(c);
  } finally { await c.end(); }
}

/** O que o dashboard faz a cada carregamento: procurar o perfil de quem entrou. */
const perfilDeQuemEntrou = (authId: string) =>
  como(authId, async (c) => (await c.query(
    "SELECT id::text, company_id::text, full_name, role FROM profiles WHERE id = auth.uid()"
  )).rows[0] ?? null);

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=hard",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "hard", max: 8 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("ADM01–ADM07 — quem já entrava continua a entrar", () => {
  it("🔴 o perfil de cada um é exactamente o mesmo antes e depois", async () => {
    await mundoAntigo();
    const antes = {
      admin: await perfilDeQuemEntrou(ids.admin),
      gestor: await perfilDeQuemEntrou(ids.gestor),
      colab: await perfilDeQuemEntrou(ids.colab),
      adminB: await perfilDeQuemEntrou(ids.adminB),
    };
    // Se o cenário deixasse de medir, isto apanhava.
    expect(antes.admin?.role).toBe("admin");

    await aplicarTudo();

    expect({
      admin: await perfilDeQuemEntrou(ids.admin),
      gestor: await perfilDeQuemEntrou(ids.gestor),
      colab: await perfilDeQuemEntrou(ids.colab),
      adminB: await perfilDeQuemEntrou(ids.adminB),
    }).toEqual(antes);
  });

  it("ADM05. 🔴 nenhuma conta válida passa a não ter perfil", async () => {
    // Foi isto que a #86 provocou: a consulta do perfil deixou de devolver
    // nada, e o dashboard mandava toda a gente para /login?error=profile.
    await mundoAntigo();
    await aplicarTudo();
    for (const quem of Object.values(ids)) {
      expect(await perfilDeQuemEntrou(quem)).not.toBeNull();
    }
  });

  it("ADM04. o resolver devolve o próprio perfil, sem voltas", async () => {
    await mundoAntigo();
    await aplicarTudo();
    for (const [nome, id] of Object.entries(ids)) {
      const resolvido = await como(id, async (c) =>
        (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id);
      expect(resolvido, nome).toBe(id);
    }
  });

  it("ADM06. os dados de cada perfil ficam intactos", async () => {
    await mundoAntigo();
    const antes = (await pool.query(
      `SELECT id::text, full_name, email, nif, iban, hourly_rate::text, role, company_id::text
         FROM profiles ORDER BY id`)).rows;
    await aplicarTudo();
    expect((await pool.query(
      `SELECT id::text, full_name, email, nif, iban, hourly_rate::text, role, company_id::text
         FROM profiles ORDER BY id`)).rows).toEqual(antes);
  });

  it("ADM07. 🔴 ninguém passa a ter de trocar a senha", async () => {
    // A coluna nasce `false` para quem já existia: nunca receberam senha
    // temporária, e não têm o que trocar. Se nascesse NULL, um código
    // defensivo mandava-os a todos para o ecrã de troca.
    await mundoAntigo();
    await aplicarTudo();
    expect((await pool.query(
      "SELECT count(*)::int n FROM profiles WHERE must_change_password")).rows[0].n).toBe(0);
  });

  it("o isolamento entre empresas aguenta-se", async () => {
    await mundoAntigo();
    await aplicarTudo();
    const vistos = await como(ids.admin, async (c) =>
      (await c.query("SELECT full_name FROM profiles ORDER BY full_name")).rows
        .map((r) => r.full_name));
    expect(vistos).toEqual(["admin", "colab", "gestor"]);
    expect(vistos).not.toContain("adminB");
  });
});

describe.sequential("consumidores — uma pessoa sem conta não parte nada", () => {
  const TABELAS = ["payroll_records", "team_members", "collaborator_documents",
    "absences", "vacation_requests", "timesheets"] as const;

  it("🔴 aparece na lista de colaboradores da empresa", async () => {
    await mundoAntigo();
    await aplicarTudo();
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
      [semConta, EMPRESA_A]);
    const vistos = await como(ids.admin, async (c) =>
      (await c.query("SELECT full_name FROM profiles ORDER BY full_name")).rows
        .map((r) => r.full_name));
    expect(vistos).toContain("Sem conta");
  });

  it.each(TABELAS)("%s aceita-a como qualquer outra pessoa", async (tabela) => {
    await mundoAntigo();
    await aplicarTudo();
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
      [semConta, EMPRESA_A]);

    // Algumas destas tabelas não têm `company_id`; passar um parâmetro que a
    // consulta não usa faz o Postgres recusar por não lhe saber o tipo.
    const comEmpresa: Record<string, string> = {
      payroll_records: "(company_id,collaborator_id,net_salary) VALUES($1,$2,800)",
      absences: "(company_id,collaborator_id,motivo) VALUES($1,$2,'d')",
      vacation_requests: "(company_id,collaborator_id) VALUES($1,$2)",
      timesheets: "(company_id,collaborator_id,horas) VALUES($1,$2,8)",
    };
    const semEmpresa: Record<string, string> = {
      team_members: "(collaborator_id) VALUES($1)",
      collaborator_documents: "(collaborator_id,file_url) VALUES($1,'c.pdf')",
    };
    const sql = `INSERT INTO ${tabela} ${comEmpresa[tabela] ?? semEmpresa[tabela]}`;
    const params = tabela in comEmpresa ? [EMPRESA_A, semConta] : [semConta];
    await expect(pool.query(sql, params)).resolves.toBeDefined();
  });

  it("🔴 os campos por preencher ficam NULL, não inventados", async () => {
    await mundoAntigo();
    await aplicarTudo();
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
      [semConta, EMPRESA_A]);
    const r = (await pool.query(
      `SELECT email, nif, iban, hourly_rate, contract_start, auth_user_id
         FROM profiles WHERE id=$1`, [semConta])).rows[0];
    expect(r).toEqual({
      email: null, nif: null, iban: null,
      hourly_rate: null, contract_start: null, auth_user_id: null,
    });
  });
});

describe.sequential("o ciclo completo, com a mesma identidade do princípio ao fim", () => {
  it("🔴 criar → dar acesso → tirar → devolver, sempre a mesma pessoa", async () => {
    await mundoAntigo();
    await aplicarTudo();

    // 1. Uma pessoa, só com o nome.
    const pessoa = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Maria')",
      [pessoa, EMPRESA_A]);
    await pool.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,900)",
      [EMPRESA_A, pessoa]);

    // 2. Dar-lhe acesso.
    const conta = randomUUID();
    await pool.query("INSERT INTO auth.users VALUES($1,$2)",
      [conta, `u-${pessoa}@acesso.interno.invalid`]);
    await pool.query(
      `UPDATE profiles SET auth_user_id=$1, must_change_password=true
        WHERE id=$2 AND auth_user_id IS NULL`, [conta, pessoa]);

    expect(await perfilDeQuemEntrou(conta)).toBeNull(); // o id da conta não é o do perfil
    expect(await como(conta, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBe(pessoa);

    // 3. Tirar o acesso.
    await pool.query("UPDATE auth.users SET banned_until='2126-01-01' WHERE id=$1", [conta]);
    expect((await pool.query(
      "SELECT count(*)::int n FROM profiles WHERE id=$1", [pessoa])).rows[0].n).toBe(1);
    expect((await pool.query(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa]))
      .rows[0].n).toBe(1);

    // 4. Devolver — a mesma conta.
    await pool.query("UPDATE auth.users SET banned_until=NULL WHERE id=$1", [conta]);
    expect((await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0].auth_user_id)
      .toBe(conta);

    // 🔴 O id da pessoa nunca mudou, e a folha continua a apontar para ela.
    expect((await pool.query(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa]))
      .rows[0].n).toBe(1);
    expect((await pool.query(
      "SELECT count(*)::int n FROM auth.users")).rows[0].n).toBe(5); // 4 antigos + 1
  });

  it("🔴 dar acesso a uma pessoa não a torna visível a outra empresa", async () => {
    await mundoAntigo();
    await aplicarTudo();
    const pessoa = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Maria')",
      [pessoa, EMPRESA_A]);
    const conta = randomUUID();
    await pool.query("INSERT INTO auth.users VALUES($1,$2)",
      [conta, `u-${pessoa}@acesso.interno.invalid`]);
    await pool.query("UPDATE profiles SET auth_user_id=$1 WHERE id=$2", [conta, pessoa]);

    const daOutra = await como(ids.adminB, async (c) =>
      (await c.query("SELECT full_name FROM profiles ORDER BY full_name")).rows
        .map((r) => r.full_name));
    expect(daOutra).toEqual(["adminB"]);
  });
});

describe.sequential("rollback de tudo, pela ordem inversa", () => {
  it("com toda a gente com conta, o schema volta ao que era", async () => {
    await mundoAntigo();
    const colunasAntes = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' ORDER BY column_name`)).rows;

    await aplicarTudo();
    await pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_resolver_rls_lote2.down.sql"));
    await pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_resolver_rls.down.sql"));
    await pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_expand.down.sql"));

    expect((await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' ORDER BY column_name`)).rows)
      .toEqual(colunasAntes);
    // E toda a gente continua a entrar.
    for (const quem of Object.values(ids)) {
      expect(await perfilDeQuemEntrou(quem)).not.toBeNull();
    }
  });

  it("🔴 havendo uma pessoa sem conta, o rollback recusa", async () => {
    await mundoAntigo();
    await aplicarTudo();
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
      [semConta, EMPRESA_A]);

    await pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_resolver_rls_lote2.down.sql"));
    await pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_resolver_rls.down.sql"));
    await expect(pool.query(readSql("supabase", "migrations", "draft", "rollback",
      "PROVISIONAL_collaborator_identity_expand.down.sql")))
      .rejects.toThrow(/ROLLBACK_BLOCKED_PROFILES_WITHOUT_AUTH/);

    // A pessoa fica, e a coluna também.
    expect((await pool.query(
      "SELECT count(*)::int n FROM profiles WHERE id=$1", [semConta])).rows[0].n).toBe(1);
  });
});
