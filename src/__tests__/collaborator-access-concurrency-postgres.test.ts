/**
 * PHASE E — a concorrência e a compensação, executadas.
 *
 * Os testes do domínio provam que a regra está certa. Estes provam que o
 * código a executa, contra um PostgreSQL real: o índice único, a gravação
 * condicional e a compensação não se reproduzem com um duplo em memória.
 *
 * O que se simula aqui é só o **Auth** — criar uma conta é uma chamada de rede
 * a um serviço que não existe neste ensaio. O que não se simula é a base: a
 * corrida entre dois administradores decide-se em Postgres, com o `UPDATE`
 * condicional e o índice único a fazerem o seu trabalho.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compensacaoNecessaria, identificadorDeAutenticacao }
  from "@/domain/collaborators/access-lifecycle";

const ROOT = process.cwd();
const CONTAINER = `access-conc-${process.pid}`;
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
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE, banned_until timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    role text NOT NULL DEFAULT 'colaborador');
  CREATE TABLE public.payroll_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    net_salary numeric(10,2));
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $c$
    SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $c$;
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $r$
    SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;
  DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
      THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
      THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
      THEN CREATE ROLE service_role; END IF;
  END $roles$;
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "acesso" });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* nunca abriu */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

async function prepara() {
  await pool.query(BASELINE);
  await pool.query(readSql("supabase", "migrations", "draft",
    "PROVISIONAL_collaborator_identity_expand.sql"));
  await pool.query("INSERT INTO companies VALUES($1,'A'),($2,'B')", [EMPRESA_A, EMPRESA_B]);
  // Uma pessoa sem conta: é para ela que se vai criar acesso.
  const pessoa = randomUUID();
  await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Maria')",
    [pessoa, EMPRESA_A]);
  await pool.query(
    "INSERT INTO payroll_records(company_id,collaborator_id,net_salary) VALUES($1,$2,1200)",
    [EMPRESA_A, pessoa]);
  return pessoa;
}

/**
 * O Auth, com as contas gravadas em `auth.users`.
 *
 * 🔴 Não é um duplo em memória, e a diferença importa: a chave estrangeira de
 *    `auth_user_id` aponta para `auth.users`, e um duplo que só guardasse ids
 *    num `Map` deixaria a ligação a apontar para o vazio — o teste passaria a
 *    provar menos do que parece. Foi isso que a primeira versão fez, e a base
 *    recusou.
 *
 *    O que continua simulado é só a **rede**: a chamada ao serviço de
 *    autenticação. O estado vive onde vive de verdade.
 */
function authFalso() {
  return {
    async contas(): Promise<string[]> {
      return (await pool.query("SELECT id::text FROM auth.users ORDER BY id"))
        .rows.map((r) => r.id);
    },
    async criar(email: string) {
      const id = randomUUID();
      try {
        await pool.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
        return { erro: null, conta: { id, email } };
      } catch {
        // O `UNIQUE` do email é o que faz a segunda tentativa não criar conta.
        return { erro: "email já em uso", conta: null };
      }
    },
    async apagar(id: string) {
      const r = await pool.query("DELETE FROM auth.users WHERE id=$1", [id]);
      return r.rowCount === 1 ? { erro: null } : { erro: "conta não encontrada" };
    },
    async banir(id: string, banido: boolean) {
      const r = await pool.query(
        "UPDATE auth.users SET banned_until = $2 WHERE id=$1",
        [id, banido ? "2126-01-01T00:00:00Z" : null]);
      return r.rowCount === 1 ? { erro: null } : { erro: "conta não encontrada" };
    },
    async estaBanido(id: string) {
      const r = await pool.query("SELECT banned_until FROM auth.users WHERE id=$1", [id]);
      return r.rows[0]?.banned_until !== null && r.rows[0]?.banned_until !== undefined;
    },
    async existe(id: string) {
      return (await pool.query("SELECT count(*)::int n FROM auth.users WHERE id=$1", [id]))
        .rows[0].n === 1;
    },
  };
}

/**
 * A mesma sequência da acção `criarAcesso`: criar a conta, gravar a ligação
 * condicionalmente, compensar se não gravar.
 *
 * `falharLigacao` força o caso que interessa provar — a escrita na base a
 * falhar depois de a conta já existir.
 */
async function criarAcesso(
  auth: ReturnType<typeof authFalso>, pessoaId: string,
  { falharLigacao = false } = {},
) {
  const { erro, conta } = await auth.criar(identificadorDeAutenticacao(pessoaId));
  if (erro || !conta) return { ok: false as const, motivo: erro ?? "sem conta" };

  let ligou = false;
  if (!falharLigacao) {
    const r = await pool.query(
      `UPDATE profiles SET auth_user_id = $1, must_change_password = true
        WHERE id = $2 AND auth_user_id IS NULL RETURNING id`,
      [conta.id, pessoaId]);
    ligou = r.rowCount === 1;
  }

  if (compensacaoNecessaria(true, ligou) === "apagar_conta") {
    await auth.apagar(conta.id);
    return { ok: false as const, motivo: "ligação não gravou; conta desfeita" };
  }
  return { ok: true as const, authId: conta.id };
}

const contarContas = async (auth: ReturnType<typeof authFalso>) =>
  (await auth.contas()).length;

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=acesso",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "acesso", max: 8 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("ACC — criar acesso, a sério", () => {
  it("ACC03. o acesso liga-se à mesma pessoa, com o mesmo id", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    const r = await criarAcesso(auth, pessoa);
    expect(r.ok).toBe(true);

    const linha = (await pool.query(
      "SELECT id::text, auth_user_id::text, must_change_password FROM profiles WHERE id=$1",
      [pessoa])).rows[0];
    expect(linha.id).toBe(pessoa);
    expect(linha.auth_user_id).toBe(r.ok && r.authId);
    expect(linha.must_change_password).toBe(true);
    // 🔴 A folha continua a apontar para a mesma pessoa.
    expect((await pool.query(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa]))
      .rows[0].n).toBe(1);
  });

  it("ACC05. repetir não cria uma segunda conta", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    await criarAcesso(auth, pessoa);
    const segunda = await criarAcesso(auth, pessoa);

    expect(segunda.ok).toBe(false);
    // A segunda tentativa nem chega a deixar conta: o email técnico é o mesmo,
    // e o Auth recusa. Uma conta, no total.
    expect(await contarContas(auth)).toBe(1);
  });

  it("🔴 ACC06. dois administradores em simultâneo — uma conta, uma ligação", async () => {
    const pessoa = await prepara();
    const auth = authFalso();

    // Os dois chamam ao mesmo tempo. Só um pode ganhar.
    const [a, b] = await Promise.all([
      criarAcesso(auth, pessoa),
      criarAcesso(auth, pessoa),
    ]);

    const vencedores = [a, b].filter((r) => r.ok);
    expect(vencedores).toHaveLength(1);
    // 🔴 O perdedor desfez a sua conta: fica uma só, e é a do vencedor.
    expect(await contarContas(auth)).toBe(1);
    const linha = (await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0];
    expect(linha.auth_user_id).toBe(vencedores[0].ok && vencedores[0].authId);
    expect(await auth.existe(linha.auth_user_id)).toBe(true);
  });

  it("🔴 a guarda está na base, não só no identificador único do Auth", async () => {
    // Um teste de mutação mostrou que os casos acima passavam mesmo sem
    // `AND auth_user_id IS NULL` no `UPDATE`: o `UNIQUE` do email técnico
    // recusava a segunda conta antes de a corrida chegar à base, e a lacuna
    // ficava escondida.
    //
    // Aqui as duas tentativas trazem contas **diferentes** — é o que
    // aconteceria se o identificador fosse gerado de outra forma, ou se duas
    // chamadas legítimas de reactivação se cruzassem. Sem a guarda, a segunda
    // sobrescreve a ligação da primeira e fica uma conta órfã sem ninguém
    // reparar.
    const pessoa = await prepara();
    const auth = authFalso();

    const primeira = await auth.criar(`a-${randomUUID()}@acesso.interno.invalid`);
    const segunda = await auth.criar(`b-${randomUUID()}@acesso.interno.invalid`);
    expect(primeira.conta && segunda.conta).toBeTruthy();

    const ligar = (authId: string) => pool.query(
      `UPDATE profiles SET auth_user_id = $1, must_change_password = true
        WHERE id = $2 AND auth_user_id IS NULL RETURNING id`,
      [authId, pessoa]);

    const r1 = await ligar(primeira.conta!.id);
    const r2 = await ligar(segunda.conta!.id);

    // 🔴 A segunda não grava: a pessoa já tem conta.
    expect(r1.rowCount).toBe(1);
    expect(r2.rowCount).toBe(0);
    expect((await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0].auth_user_id)
      .toBe(primeira.conta!.id);
  });

  it("🔴 e com cinco ao mesmo tempo continua a ser uma", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => criarAcesso(auth, pessoa)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await contarContas(auth)).toBe(1);
  });
});

describe.sequential("FAIL — compensação executada", () => {
  it("🔴 FAIL01. conta criada e ligação falhada → a conta é desfeita", async () => {
    const pessoa = await prepara();
    const auth = authFalso();

    const r = await criarAcesso(auth, pessoa, { falharLigacao: true });
    expect(r.ok).toBe(false);

    // 🔴 Não fica identidade nenhuma capaz de autenticar sem dono.
    expect(await contarContas(auth)).toBe(0);
    expect((await pool.query(
      "SELECT auth_user_id FROM profiles WHERE id=$1", [pessoa])).rows[0].auth_user_id)
      .toBeNull();
  });

  it("🔴 FAIL02. a pessoa e o histórico dela ficam intactos", async () => {
    const pessoa = await prepara();
    const antes = (await pool.query(
      "SELECT id::text, full_name, company_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0];

    await criarAcesso(authFalso(), pessoa, { falharLigacao: true });

    expect((await pool.query(
      "SELECT id::text, full_name, company_id::text FROM profiles WHERE id=$1", [pessoa]))
      .rows[0]).toEqual(antes);
    expect((await pool.query(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa]))
      .rows[0].n).toBe(1);
  });

  it("depois de compensar, tentar outra vez funciona", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    await criarAcesso(auth, pessoa, { falharLigacao: true });
    // 🔴 É por isto que a compensação apaga a conta: se ficasse, o
    //    identificador estava ocupado e ninguém mais conseguia criar acesso a
    //    esta pessoa.
    const r = await criarAcesso(auth, pessoa);
    expect(r.ok).toBe(true);
    expect(await contarContas(auth)).toBe(1);
  });
});

describe.sequential("o índice único é a rede por baixo", () => {
  it("🔴 duas pessoas não podem partilhar a mesma conta", async () => {
    const pessoa = await prepara();
    const outra = randomUUID();
    await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,'Outra')",
      [outra, EMPRESA_A]);
    const auth = authFalso();
    const r = await criarAcesso(auth, pessoa);
    expect(r.ok).toBe(true);

    // Mesmo que o código falhasse, a base recusa.
    await expect(pool.query("UPDATE profiles SET auth_user_id=$1 WHERE id=$2",
      [r.ok && r.authId, outra])).rejects.toThrow(/uq_profiles_auth_user_id/);
  });

  it("várias pessoas sem conta convivem", async () => {
    await prepara();
    for (const nome of ["Ana", "Beatriz"]) {
      await pool.query("INSERT INTO profiles(id,company_id,full_name) VALUES($1,$2,$3)",
        [randomUUID(), EMPRESA_A, nome]);
    }
    expect((await pool.query(
      "SELECT count(*)::int n FROM profiles WHERE auth_user_id IS NULL")).rows[0].n).toBe(3);
  });
});

describe.sequential("desactivar e reactivar", () => {
  it("ACC07. desactivar não apaga a pessoa nem o histórico", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    const r = await criarAcesso(auth, pessoa);
    expect(r.ok).toBe(true);

    await auth.banir(r.ok ? r.authId : "", true);

    expect(await auth.estaBanido(r.ok ? r.authId : "")).toBe(true);
    // 🔴 A pessoa fica, a ligação fica, a folha fica.
    const linha = (await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0];
    expect(linha.auth_user_id).toBe(r.ok && r.authId);
    expect((await pool.query(
      "SELECT count(*)::int n FROM payroll_records WHERE collaborator_id=$1", [pessoa]))
      .rows[0].n).toBe(1);
  });

  it("ACC08. reactivar devolve a mesma conta", async () => {
    const pessoa = await prepara();
    const auth = authFalso();
    const r = await criarAcesso(auth, pessoa);
    const authId = r.ok ? r.authId : "";

    await auth.banir(authId, true);
    await auth.banir(authId, false);

    expect(await auth.estaBanido(authId)).toBe(false);
    expect(await contarContas(auth)).toBe(1);
    // A mesma, não outra.
    expect((await pool.query(
      "SELECT auth_user_id::text FROM profiles WHERE id=$1", [pessoa])).rows[0].auth_user_id)
      .toBe(authId);
  });
});
