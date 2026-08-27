/**
 * A PHASE A não pode enfraquecer a protecção da 069.
 *
 * A 069 corrigiu uma escalada de privilégios real: `profiles_update_own` tinha
 * `USING (id = auth.uid())` sem `WITH CHECK` explícito, e como o Postgres
 * reutiliza o `USING` como `CHECK`, qualquer conta autenticada podia fazer
 *
 *     UPDATE profiles SET company_id = <outra empresa>, role = 'admin'
 *      WHERE id = auth.uid()
 *
 * e passar — o `id` não mudava, e era a única coisa verificada. Auto-promoção
 * a admin em qualquer empresa cujo UUID o atacante conhecesse.
 *
 * A protecção real que a 069 instalou é um **trigger**, não a política. Isso
 * importa aqui: o EXPAND larga a chave estrangeira de `profiles.id` e permite
 * pessoas sem conta, o que muda o significado de `id = auth.uid()`. Se a
 * defesa dependesse dessa igualdade, o EXPAND tê-la-ia enfraquecido em
 * silêncio.
 *
 * Este ficheiro prova que não depende: o trigger usa `auth.role()` e os
 * helpers da 014, e continua a recusar exactamente o mesmo depois do EXPAND.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `guard-069-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

let port = 0;
let pool: pg.Pool;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA auth;

  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;
  -- O papel com que o pedido chegou à API: 'authenticated' ou 'service_role'.
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

  DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
      THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
      THEN CREATE ROLE service_role; END IF;
  END $roles$;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
  GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "guard" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

/** Instala a base, a guarda da 069 e — opcionalmente — o EXPAND. */
async function prepara(comExpand: boolean) {
  await pool.query(BASELINE);
  await pool.query("INSERT INTO companies VALUES($1,'A'),($2,'B')", [EMPRESA_A, EMPRESA_B]);
  const colab = randomUUID();
  const admin = randomUUID();
  for (const [id, nome, papel] of [[colab, "Colaboradora", "colaborador"], [admin, "Admin", "admin"]] as const) {
    await pool.query("INSERT INTO auth.users VALUES($1,$2)", [id, `${nome}@exemplo.pt`]);
    await pool.query("INSERT INTO profiles(id,company_id,full_name,role) VALUES($1,$2,$3,$4)",
      [id, EMPRESA_A, nome, papel]);
  }
  await pool.query(readSql("supabase", "migrations", "069_guard_profile_tenant_role.sql"));
  if (comExpand) {
    await pool.query(readSql("supabase", "migrations", "draft",
      "PROVISIONAL_collaborator_identity_expand.sql"));
  }
  return { colab, admin };
}

/** Corre como aquele utilizador, com o papel de API indicado. */
async function como<T>(authId: string, papelApi: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "guard" });
  await c.connect();
  try {
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId]);
    await c.query("SELECT set_config('request.jwt.claim.role', $1, false)", [papelApi]);
    return await fn(c);
  } finally { await c.end(); }
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=guard",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "guard", max: 8 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("a guarda da 069 aguenta-se depois do EXPAND", () => {
  it.each([[false], [true]])("auto-promoção a admin é recusada (comExpand=%s)", async (comExpand) => {
    const { colab } = await prepara(comExpand);
    await expect(como(colab, "authenticated", (c) =>
      c.query("UPDATE profiles SET role='admin' WHERE id = auth.uid()")))
      .rejects.toThrow(/PROFILE_ROLE_ESCALATION_BLOCKED|PROFILE_COMPANY_CHANGE_BLOCKED|denied/i);
    expect((await pool.query("SELECT role FROM profiles WHERE id=$1", [colab])).rows[0].role)
      .toBe("colaborador");
  });

  it.each([[false], [true]])("mudar-se de empresa é recusado (comExpand=%s)", async (comExpand) => {
    const { colab } = await prepara(comExpand);
    await expect(como(colab, "authenticated", (c) =>
      c.query("UPDATE profiles SET company_id=$1 WHERE id = auth.uid()", [EMPRESA_B])))
      .rejects.toThrow(/PROFILE_COMPANY_CHANGE_BLOCKED/);
    expect((await pool.query("SELECT company_id::text FROM profiles WHERE id=$1", [colab]))
      .rows[0].company_id).toBe(EMPRESA_A);
  });

  it.each([[false], [true]])("nem um admin move perfis entre empresas (comExpand=%s)", async (comExpand) => {
    const { admin } = await prepara(comExpand);
    await expect(como(admin, "authenticated", (c) =>
      c.query("UPDATE profiles SET company_id=$1 WHERE id = auth.uid()", [EMPRESA_B])))
      .rejects.toThrow(/PROFILE_COMPANY_CHANGE_BLOCKED/);
  });

  it.each([[false], [true]])("alterações inofensivas continuam livres (comExpand=%s)", async (comExpand) => {
    const { colab } = await prepara(comExpand);
    await como(colab, "authenticated", (c) =>
      c.query("UPDATE profiles SET phone='912345678' WHERE id = auth.uid()"));
    expect((await pool.query("SELECT phone FROM profiles WHERE id=$1", [colab])).rows[0].phone)
      .toBe("912345678");
  });

  it("🔴 o EXPAND não abre a porta a uma pessoa sem conta se promover", async () => {
    await prepara(true);
    // Só possível depois do EXPAND: uma pessoa sem conta de acesso.
    const semConta = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem conta')",
      [semConta, EMPRESA_A]);
    // Um token forjado com o id dela não a promove — o trigger vê `auth.role()`
    // e recusa na mesma.
    await expect(como(semConta, "authenticated", (c) =>
      c.query("UPDATE profiles SET role='admin' WHERE id=$1", [semConta])))
      .rejects.toThrow(/PROFILE_ROLE_ESCALATION_BLOCKED|PROFILE_COMPANY_CHANGE_BLOCKED/);
    expect((await pool.query("SELECT role FROM profiles WHERE id=$1", [semConta])).rows[0].role)
      .toBe("colaborador");
  });
});
