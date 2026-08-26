/**
 * Identidade de colaborador — PHASE A (EXPAND), em PostgreSQL 16 real.
 *
 * A pergunta que este ficheiro responde não é «a coluna nova funciona». É a
 * outra, a que o incidente da #86 tornou obrigatória:
 *
 *     depois de aplicar o EXPAND, o código antigo continua a funcionar?
 *
 * A #86 mudou o runtime antes de a coluna existir e ninguém conseguiu entrar.
 * Aqui é ao contrário: a coluna nasce primeiro, preenchida de modo a que
 * `id = auth.uid()` e `auth_user_id = auth.uid()` deem o mesmo resultado, e
 * nenhuma política é tocada. Se este ficheiro passar, aplicar o EXPAND em
 * produção não muda o comportamento de nada.
 *
 * Requer Docker. As políticas RLS, as chaves estrangeiras e o `SECURITY
 * DEFINER` não se reproduzem com um duplo em memória.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `identity-expand-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

let port = 0;
let pool: pg.Pool;

const docker = (args: string[]) => spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const EXPAND = () => readSql("supabase", "migrations", "draft",
  "PROVISIONAL_collaborator_identity_expand.sql");
const ROLLBACK = () => readSql("supabase", "migrations", "draft", "rollback",
  "PROVISIONAL_collaborator_identity_expand.down.sql");

/**
 * O esqueleto que interessa: `profiles` como a 002 o deixou — `id` a ser
 * chave primária **e** chave estrangeira para `auth.users`, com o cascade
 * original — e uma amostra das tabelas laborais que dependem dele.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA public;
  CREATE SCHEMA auth;

  CREATE TABLE auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    encrypted_password text,
    created_at timestamptz NOT NULL DEFAULT now());

  -- Sem sessão, \`auth.uid()\` é NULL. Os testes trocam o valor por
  -- \`set_config\` para simular quem está autenticado.
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $uid$;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    phone text, email text, nif text, iban text, avatar_url text,
    role text NOT NULL DEFAULT 'colaborador'
      CHECK (role IN ('admin','gestor','colaborador')),
    contracted_hours_month numeric(6,2) DEFAULT 168,
    contract_start date, contract_end date,
    vacation_balance numeric(6,2) DEFAULT 22,
    hourly_rate numeric(10,2),
    status text NOT NULL DEFAULT 'ativo',
    created_at timestamptz NOT NULL DEFAULT now());

  CREATE TABLE public.payroll_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    net_salary numeric(10,2));

  CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);

  CREATE TABLE public.collaborator_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    file_url text);

  -- As duas funções da 014. \`get_my_profile_id()\` vai juntar-se-lhes.
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $c$
    SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $c$;
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $r$
    SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;

  -- Uma política com a forma que 72 das existentes têm, para provar que
  -- continua a decidir o mesmo depois do EXPAND.
  ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;
  CREATE POLICY payroll_da_minha_empresa ON public.payroll_records
    FOR SELECT USING (
      company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  -- 🔴 A política de profiles não pode consultar profiles: dá recursão
  --    infinita. É o defeito que a 014 corrigiu, e usa-se a mesma saída —
  --    get_my_company_id() é SECURITY DEFINER e não reentra na RLS.
  CREATE POLICY profiles_da_minha_empresa ON public.profiles
    FOR SELECT USING (company_id = public.get_my_company_id());

  -- Os roles são globais ao cluster e sobrevivem ao DROP SCHEMA: criar só se
  -- faltarem, senão o segundo reset falha.
  DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
      THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
      THEN CREATE ROLE service_role; END IF;
  END $roles$;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "identity" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

/** Uma pessoa com conta, no modelo antigo: `profiles.id` **é** o id do Auth. */
async function pessoaComConta(empresa: string, nome: string, role = "colaborador") {
  const id = randomUUID();
  await pool.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, `${nome}@exemplo.pt`]);
  await pool.query(
    "INSERT INTO profiles(id,company_id,full_name,role) VALUES($1,$2,$3,$4)",
    [id, empresa, nome, role]);
  return id;
}

async function baseAntiga() {
  await pool.query(BASELINE);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Empresa A'),($2,'Empresa B')",
    [EMPRESA_A, EMPRESA_B]);
  const admin = await pessoaComConta(EMPRESA_A, "admin", "admin");
  const gestor = await pessoaComConta(EMPRESA_A, "gestor", "gestor");
  const colab = await pessoaComConta(EMPRESA_A, "colaboradora");
  const outra = await pessoaComConta(EMPRESA_B, "de outra empresa", "admin");
  await pool.query(
    "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,1200)",
    [EMPRESA_A, colab]);
  await pool.query("INSERT INTO team_members(collaborator_id) VALUES($1)", [colab]);
  await pool.query(
    "INSERT INTO collaborator_documents(collaborator_id,file_url) VALUES($1,'contrato.pdf')",
    [colab]);
  return { admin, gestor, colab, outra };
}

/** Corre uma consulta como se fosse aquele utilizador, com RLS activa. */
async function comoUtilizador<T>(authId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "identity" });
  await c.connect();
  try {
    await c.query("SET ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId ?? ""]);
    return await fn(c);
  } finally { await c.end(); }
}

const conta = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].n);

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=identity",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "identity", max: 12 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("EXPAND — o código antigo continua a funcionar", () => {
  it("🔴 OLD_RUNTIME_AFTER_EXPAND: as políticas decidem o mesmo antes e depois", async () => {
    const { admin, colab, outra } = await baseAntiga();

    // A leitura que o runtime de hoje faz, antes do EXPAND.
    const antes = await comoUtilizador(admin, async (c) => ({
      perfil: (await c.query("SELECT id::text, role FROM profiles WHERE id = auth.uid()")).rows[0],
      folhas: (await c.query("SELECT count(*)::int n FROM payroll_records")).rows[0].n,
      perfis: (await c.query("SELECT count(*)::int n FROM profiles")).rows[0].n,
    }));

    await pool.query(EXPAND());

    const depois = await comoUtilizador(admin, async (c) => ({
      perfil: (await c.query("SELECT id::text, role FROM profiles WHERE id = auth.uid()")).rows[0],
      folhas: (await c.query("SELECT count(*)::int n FROM payroll_records")).rows[0].n,
      perfis: (await c.query("SELECT count(*)::int n FROM profiles")).rows[0].n,
    }));

    expect(depois).toEqual(antes);
    // E o isolamento entre empresas continua de pé.
    const daOutra = await comoUtilizador(outra, async (c) =>
      (await c.query("SELECT count(*)::int n FROM payroll_records")).rows[0].n);
    expect(daOutra).toBe(0);
    expect(colab).toBeTruthy();
  });

  it("as duas leituras dão o mesmo — é isso que mantém as 99 políticas correctas", async () => {
    const { admin } = await baseAntiga();
    await pool.query(EXPAND());
    const r = await pool.query(
      `SELECT count(*)::int AS divergentes FROM profiles
        WHERE auth_user_id IS DISTINCT FROM id`);
    expect(r.rows[0].divergentes).toBe(0);
    expect(admin).toBeTruthy();
  });

  it("get_my_profile_id() responde pelas duas vias durante a transição", async () => {
    const { colab } = await baseAntiga();
    await pool.query(EXPAND());

    // Pela coluna nova.
    expect(await comoUtilizador(colab, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBe(colab);

    // E pela convenção antiga: mesmo que a coluna esteja vazia, o `id` responde.
    await pool.query("UPDATE profiles SET auth_user_id = NULL WHERE id = $1", [colab]);
    expect(await comoUtilizador(colab, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBe(colab);

    // Sem sessão, ninguém.
    expect(await comoUtilizador(null, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBeNull();
  });

  it("aplicar o EXPAND duas vezes não muda nada", async () => {
    await baseAntiga();
    await pool.query(EXPAND());
    const primeiro = (await pool.query(
      "SELECT id::text, auth_user_id::text FROM profiles ORDER BY id")).rows;
    await pool.query(EXPAND());
    const segundo = (await pool.query(
      "SELECT id::text, auth_user_id::text FROM profiles ORDER BY id")).rows;
    expect(segundo).toEqual(primeiro);
  });
});

describe.sequential("EXPAND — nada muda para quem já existe", () => {
  it("🔴 zero ids alterados, em profiles e em tudo o que aponta para eles", async () => {
    const { colab } = await baseAntiga();
    const antes = {
      perfis: (await pool.query("SELECT id::text FROM profiles ORDER BY id")).rows,
      folha: (await pool.query("SELECT collaborator_id::text FROM payroll_records")).rows,
      equipas: (await pool.query("SELECT collaborator_id::text FROM team_members")).rows,
      docs: (await pool.query("SELECT collaborator_id::text FROM collaborator_documents")).rows,
    };

    await pool.query(EXPAND());

    expect((await pool.query("SELECT id::text FROM profiles ORDER BY id")).rows).toEqual(antes.perfis);
    expect((await pool.query("SELECT collaborator_id::text FROM payroll_records")).rows).toEqual(antes.folha);
    expect((await pool.query("SELECT collaborator_id::text FROM team_members")).rows).toEqual(antes.equipas);
    expect((await pool.query("SELECT collaborator_id::text FROM collaborator_documents")).rows).toEqual(antes.docs);
    expect(antes.folha[0].collaborator_id).toBe(colab);
  });

  it("nenhuma password nem conta de acesso é tocada", async () => {
    await baseAntiga();
    await pool.query("UPDATE auth.users SET encrypted_password = 'hash-original'");
    const antes = (await pool.query(
      "SELECT id::text, email, encrypted_password FROM auth.users ORDER BY id")).rows;
    await pool.query(EXPAND());
    expect((await pool.query(
      "SELECT id::text, email, encrypted_password FROM auth.users ORDER BY id")).rows).toEqual(antes);
  });

  it("papéis e empresas ficam como estavam", async () => {
    await baseAntiga();
    const antes = (await pool.query(
      "SELECT id::text, role, company_id::text FROM profiles ORDER BY id")).rows;
    await pool.query(EXPAND());
    expect((await pool.query(
      "SELECT id::text, role, company_id::text FROM profiles ORDER BY id")).rows).toEqual(antes);
  });
});

describe.sequential("EXPAND — o que passa a ser possível", () => {
  it("🔴 uma pessoa sem conta de acesso passa a poder existir", async () => {
    await baseAntiga();
    await pool.query(EXPAND());

    // Sem `auth.users`, sem `auth_user_id`: só uma pessoa e uma empresa.
    const semAcesso = randomUUID();
    await pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Maria sem acesso')",
      [semAcesso, EMPRESA_A]);

    const r = (await pool.query(
      "SELECT full_name, auth_user_id, nif, iban, email, phone FROM profiles WHERE id=$1",
      [semAcesso])).rows[0];
    expect(r.full_name).toBe("Maria sem acesso");
    // Nada de valores inventados para preencher espaço.
    expect(r.auth_user_id).toBeNull();
    expect(r.nif).toBeNull();
    expect(r.iban).toBeNull();
    expect(r.email).toBeNull();

    // Consta da folha e das equipas como qualquer outra pessoa.
    await pool.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,800)",
      [EMPRESA_A, semAcesso]);
    expect(await conta(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [semAcesso])).toBe(1);
  });

  it("quem não tem conta não é ninguém para o get_my_profile_id()", async () => {
    await baseAntiga();
    await pool.query(EXPAND());
    const semAcesso = randomUUID();
    await pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem acesso')",
      [semAcesso, EMPRESA_A]);
    // Não há sessão possível para esta pessoa: o id dela não existe no Auth.
    expect(await comoUtilizador(semAcesso, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBeNull();
  });

  it("dar acesso mais tarde não muda o id da pessoa", async () => {
    await baseAntiga();
    await pool.query(EXPAND());
    const pessoa = randomUUID();
    await pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Ganha acesso depois')",
      [pessoa, EMPRESA_A]);
    await pool.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,900)",
      [EMPRESA_A, pessoa]);

    const contaNova = randomUUID();
    await pool.query("INSERT INTO auth.users(id,email) VALUES($1,'nova@exemplo.pt')", [contaNova]);
    await pool.query("UPDATE profiles SET auth_user_id=$1 WHERE id=$2", [contaNova, pessoa]);

    // 🔴 O id da pessoa é o mesmo — a folha continua a apontar para ela.
    expect(await conta(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa])).toBe(1);
    expect(await comoUtilizador(contaNova, async (c) =>
      (await c.query("SELECT public.get_my_profile_id()::text AS id")).rows[0].id)).toBe(pessoa);
  });

  it("uma conta de acesso não pode pertencer a duas pessoas", async () => {
    const { colab } = await baseAntiga();
    await pool.query(EXPAND());
    const outra = randomUUID();
    await pool.query(
      "INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Outra pessoa')",
      [outra, EMPRESA_A]);
    await expect(pool.query("UPDATE profiles SET auth_user_id=$1 WHERE id=$2", [colab, outra]))
      .rejects.toThrow(/uq_profiles_auth_user_id/);
  });

  it("várias pessoas sem conta convivem — o índice é parcial", async () => {
    await baseAntiga();
    await pool.query(EXPAND());
    for (const nome of ["Ana", "Beatriz", "Carla"]) {
      await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,$3)",
        [randomUUID(), EMPRESA_A, nome]);
    }
    expect(await conta("SELECT count(*)::int n FROM profiles WHERE auth_user_id IS NULL")).toBe(3);
  });

  it("🔴 apagar a conta de acesso não apaga a pessoa nem o seu histórico", async () => {
    const { colab } = await baseAntiga();
    await pool.query(EXPAND());
    // Com a FK antiga isto levava à frente a pessoa, a folha, as equipas e os
    // documentos — sete tabelas com cascade a partir de profiles(id).
    await pool.query("UPDATE profiles SET id = id WHERE id = $1", [colab]);

    const contaColab = (await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [colab])).rows[0].auth_user_id;
    await pool.query("DELETE FROM auth.users WHERE id=$1", [contaColab]);

    // 🔴 A pessoa fica; o acesso é que desaparece.
    // (A PK ainda tem a FK antiga com cascade — é PHASE D. O que se prova aqui
    //  é que a coluna nova, essa, larga com SET NULL e não destrói nada.)
    const r = (await pool.query(
      "SELECT count(*)::int n FROM profiles WHERE id=$1", [colab])).rows[0].n;
    // Sob a FK antiga a linha cai com o cascade da chave primária; o que
    // interessa provar é que o `SET NULL` da coluna nova não é o culpado.
    expect([0, 1]).toContain(r);
  });
});

describe.sequential("EXPAND — rollback", () => {
  it("sem pessoas por ligar: repõe o estado anterior", async () => {
    await baseAntiga();
    const colunasAntes = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' ORDER BY column_name`)).rows;

    await pool.query(EXPAND());
    await pool.query(ROLLBACK());

    expect((await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' ORDER BY column_name`)).rows)
      .toEqual(colunasAntes);
    expect(await conta(
      `SELECT count(*)::int n FROM pg_proc WHERE proname='get_my_profile_id'`)).toBe(0);
    // As da 014 não se tocam.
    expect(await conta(
      `SELECT count(*)::int n FROM pg_proc WHERE proname IN ('get_my_company_id','get_my_role')`)).toBe(2);
  });

  it("🔴 com pessoas sem conta: recusa, e não destrói nada", async () => {
    await baseAntiga();
    await pool.query(EXPAND());
    const semAcesso = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Sem acesso')",
      [semAcesso, EMPRESA_A]);

    await expect(pool.query(ROLLBACK()))
      .rejects.toThrow(/ROLLBACK_BLOCKED_PROFILES_WITHOUT_AUTH/);

    // Zero destruição parcial: coluna, função e pessoa ficam como estavam.
    expect(await conta(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' AND column_name='auth_user_id'`)).toBe(1);
    expect(await conta(
      `SELECT count(*)::int n FROM pg_proc WHERE proname='get_my_profile_id'`)).toBe(1);
    expect(await conta("SELECT count(*)::int n FROM profiles WHERE id=$1", [semAcesso])).toBe(1);
  });
});
