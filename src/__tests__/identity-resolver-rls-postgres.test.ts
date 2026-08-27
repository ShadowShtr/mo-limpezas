/**
 * PHASE C — as políticas de `profiles` passam a usar o resolver.
 *
 * A pergunta que estes testes respondem é dupla:
 *
 *   1. o que era permitido continua permitido, e o que era negado continua
 *      negado — para todos os papéis, e nas quatro operações;
 *   2. o isolamento entre empresas aguenta-se **sem** depender de Server
 *      Actions. O que se prova aqui é a base de dados a dizer não, que é o
 *      que resta quando alguém chama a API REST directamente.
 *
 * Corre com a RLS realmente activa, com `SET ROLE authenticated` e o `sub` do
 * JWT trocado por `set_config` — não com o superutilizador, que ignoraria
 * tudo o que interessa medir.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `resolver-rls-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

let port = 0;
let pool: pg.Pool;
let pessoas: Record<string, string> = {};

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const EXPAND = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_expand.sql");
const RESOLVER_RLS = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_resolver_rls.sql");
const RESOLVER_RLS_DOWN = () => readSql("supabase", "migrations", "draft", "rollback",
  "PROVISIONAL_collaborator_identity_resolver_rls.down.sql");

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
    phone text,
    role text NOT NULL DEFAULT 'colaborador'
      CHECK (role IN ('admin','gestor','colaborador')));

  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $c$
    SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $c$;
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $r$
    SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

  -- As formas que a 014 e a 015 deixaram, antes da PHASE C.
  CREATE POLICY "profiles_select" ON profiles
    FOR SELECT USING (id = auth.uid() OR company_id = get_my_company_id());
  CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (id = auth.uid())
    WITH CHECK (id = auth.uid() AND company_id = public.get_my_company_id());
  CREATE POLICY "profiles_manage_company" ON profiles
    FOR ALL USING (
      company_id = get_my_company_id() AND get_my_role() IN ('admin','gestor'));

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
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "rls" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

/** Base + EXPAND e, opcionalmente, a PHASE C. */
async function prepara(comResolver: boolean) {
  await pool.query(BASELINE);
  await pool.query("INSERT INTO companies VALUES($1,'A'),($2,'B')", [EMPRESA_A, EMPRESA_B]);
  const criar = async (empresa: string, nome: string, papel: string) => {
    const id = randomUUID();
    await pool.query("INSERT INTO auth.users VALUES($1,$2)", [id, `${nome}@exemplo.pt`]);
    await pool.query("INSERT INTO profiles(id,company_id,full_name,role) VALUES($1,$2,$3,$4)",
      [id, empresa, nome, papel]);
    return id;
  };
  pessoas = {
    adminA: await criar(EMPRESA_A, "adminA", "admin"),
    gestorA: await criar(EMPRESA_A, "gestorA", "gestor"),
    colabA: await criar(EMPRESA_A, "colabA", "colaborador"),
    colegaA: await criar(EMPRESA_A, "colegaA", "colaborador"),
    adminB: await criar(EMPRESA_B, "adminB", "admin"),
    colabB: await criar(EMPRESA_B, "colabB", "colaborador"),
  };
  await pool.query(EXPAND());
  if (comResolver) await pool.query(RESOLVER_RLS());
}

/**
 * Uma ligação como a API a faria: papel `authenticated` (ou `anon`) e o `sub`
 * do JWT. É isto que um pedido REST directo tem — sem Server Action pelo meio.
 */
async function comoRest<T>(
  authId: string | null, papel: "authenticated" | "anon",
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "rls" });
  await c.connect();
  try {
    await c.query(`SET ROLE ${papel}`);
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId ?? ""]);
    await c.query("SELECT set_config('request.jwt.claim.role', $1, false)", [papel]);
    return await fn(c);
  } finally { await c.end(); }
}

const vistos = (authId: string | null, papel: "authenticated" | "anon" = "authenticated") =>
  comoRest(authId, papel, async (c) =>
    (await c.query("SELECT full_name FROM profiles ORDER BY full_name")).rows.map((r) => r.full_name));

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=rls",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "rls", max: 8 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("PHASE C — o resolver decide o mesmo que o auth.uid()", () => {
  it("🔴 SELECT: cada papel vê exactamente o mesmo antes e depois", async () => {
    await prepara(false);
    const antes = {
      adminA: await vistos(pessoas.adminA),
      gestorA: await vistos(pessoas.gestorA),
      colabA: await vistos(pessoas.colabA),
      adminB: await vistos(pessoas.adminB),
      anon: await vistos(null, "anon"),
    };
    // Guarda contra um teste que não estivesse a medir nada.
    expect(antes.adminA.length).toBeGreaterThan(0);
    expect(antes.anon).toEqual([]);

    await prepara(true);
    expect({
      adminA: await vistos(pessoas.adminA),
      gestorA: await vistos(pessoas.gestorA),
      colabA: await vistos(pessoas.colabA),
      adminB: await vistos(pessoas.adminB),
      anon: await vistos(null, "anon"),
    }).toEqual(antes);
  });

  it("cada pessoa vê a sua empresa e mais nenhuma", async () => {
    await prepara(true);
    expect(await vistos(pessoas.colabA)).toEqual(["adminA", "colabA", "colegaA", "gestorA"]);
    expect(await vistos(pessoas.colabB)).toEqual(["adminB", "colabB"]);
  });

  it("UPDATE do próprio perfil continua a funcionar", async () => {
    await prepara(true);
    await comoRest(pessoas.colabA, "authenticated", (c) =>
      c.query("UPDATE profiles SET phone='911111111' WHERE id=$1", [pessoas.colabA]));
    expect((await pool.query("SELECT phone FROM profiles WHERE id=$1", [pessoas.colabA]))
      .rows[0].phone).toBe("911111111");
  });

  it("🔴 UPDATE do perfil de um colega não passa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.colabA, "authenticated", (c) =>
      c.query("UPDATE profiles SET phone='912222222' WHERE id=$1", [pessoas.colegaA]));
    // A política nega em silêncio: zero linhas, não uma excepção.
    expect(r.rowCount).toBe(0);
    expect((await pool.query("SELECT phone FROM profiles WHERE id=$1", [pessoas.colegaA]))
      .rows[0].phone).toBeNull();
  });
});

describe.sequential("PHASE C — isolamento entre empresas, sem Server Action", () => {
  it("🔴 REST directo: um admin não lê perfis de outra empresa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.adminA, "authenticated", (c) =>
      c.query("SELECT full_name FROM profiles WHERE company_id=$1", [EMPRESA_B]));
    expect(r.rows).toEqual([]);
  });

  it("🔴 REST directo: um admin não altera perfis de outra empresa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.adminA, "authenticated", (c) =>
      c.query("UPDATE profiles SET full_name='invadido' WHERE id=$1", [pessoas.colabB]));
    expect(r.rowCount).toBe(0);
    expect((await pool.query("SELECT full_name FROM profiles WHERE id=$1", [pessoas.colabB]))
      .rows[0].full_name).toBe("colabB");
  });

  it("🔴 REST directo: um admin não apaga perfis de outra empresa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.adminA, "authenticated", (c) =>
      c.query("DELETE FROM profiles WHERE id=$1", [pessoas.colabB]));
    expect(r.rowCount).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM profiles WHERE id=$1", [pessoas.colabB]))
      .rows[0].n).toBe(1);
  });

  it("🔴 REST directo: um admin não insere perfis noutra empresa", async () => {
    await prepara(true);
    await pool.query("INSERT INTO auth.users VALUES($1,'intruso@x.pt')",
      [pessoas.intruso = randomUUID()]);
    await expect(comoRest(pessoas.adminA, "authenticated", (c) =>
      c.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Intruso')",
        [pessoas.intruso, EMPRESA_B]))).rejects.toThrow(/row-level security/i);
  });

  it("🔴 um colaborador não gere perfis nem da própria empresa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.colabA, "authenticated", (c) =>
      c.query("DELETE FROM profiles WHERE id=$1", [pessoas.colegaA]));
    expect(r.rowCount).toBe(0);
  });

  it("um admin gere os perfis da sua empresa", async () => {
    await prepara(true);
    const r = await comoRest(pessoas.adminA, "authenticated", (c) =>
      c.query("UPDATE profiles SET phone='913333333' WHERE id=$1", [pessoas.colegaA]));
    expect(r.rowCount).toBe(1);
  });

  it("anónimo não vê nem escreve nada", async () => {
    await prepara(true);
    expect(await vistos(null, "anon")).toEqual([]);
    const r = await comoRest(null, "anon", (c) =>
      c.query("UPDATE profiles SET phone='914444444' WHERE id=$1", [pessoas.colabA]));
    expect(r.rowCount).toBe(0);
  });
});

describe.sequential("PHASE C — falha fechada", () => {
  it("🔴 sem sessão, o resolver não devolve ninguém — e não abre a porta", async () => {
    await prepara(true);
    expect(await comoRest(null, "authenticated", async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBeNull();
    // NULL não pode significar «vê tudo»: `id = NULL` nunca é verdadeiro.
    expect(await vistos(null)).toEqual([]);
  });

  it("🔴 um id que não é de ninguém não vê nada", async () => {
    await prepara(true);
    expect(await vistos(randomUUID())).toEqual([]);
  });

  it("🔴 o id de uma pessoa sem conta não empresta a identidade dela", async () => {
    await prepara(true);
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name,role) VALUES($1,$2,'Sem conta','admin')",
      [semConta, EMPRESA_A]);

    // Ela é colega e aparece na lista da empresa — isso é correcto e esperado.
    expect(await vistos(pessoas.colabA)).toContain("Sem conta");

    // 🔴 O que não pode acontecer: um token forjado com o id dela dar acesso
    //    como se fosse ela. Ela é `admin`; se o resolver a devolvesse, quem
    //    forjasse o token herdava a empresa e o papel.
    expect(await comoRest(semConta, "authenticated", async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBeNull();
    expect(await vistos(semConta)).toEqual([]);

    // E não consegue alterar o perfil dela própria por essa via.
    const r = await comoRest(semConta, "authenticated", (c) =>
      c.query("UPDATE profiles SET full_name='alterado' WHERE id=$1", [semConta]));
    expect(r.rowCount).toBe(0);
  });
});

describe.sequential("PHASE C — rollback", () => {
  it("repõe as políticas na forma da 014 e da 069", async () => {
    await prepara(true);
    const comResolver = await vistos(pessoas.colabA);

    await pool.query(RESOLVER_RLS_DOWN());

    const defs = (await pool.query(
      `SELECT policyname, qual, with_check FROM pg_policies
        WHERE tablename='profiles' AND policyname IN ('profiles_select','profiles_update_own')
        ORDER BY policyname`)).rows;
    // Voltaram a mencionar auth.uid() e deixaram de mencionar o resolver.
    expect(defs.map((d) => d.qual).join(" ")).toContain("auth.uid()");
    expect(defs.map((d) => d.qual).join(" ")).not.toContain("get_my_profile_id");
    // 🔴 O WITH CHECK da 069 tem de voltar: sem ele, a escalada reabre.
    const upd = defs.find((d) => d.policyname === "profiles_update_own");
    expect(upd?.with_check).toContain("get_my_company_id");
    // E o comportamento é o mesmo, porque cada perfil ainda tem uma conta.
    expect(await vistos(pessoas.colabA)).toEqual(comResolver);
  });
});
