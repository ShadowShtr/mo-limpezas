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

import { baselineCompleto } from "./helpers/production-baseline";

const ROOT = process.cwd();
const CONTAINER = `hardening-${process.pid}`;
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

// Cadeia mínima que o schema real exige: um serviço precisa de local, que
// precisa de cliente. Antes, com o baseline à mão, nada disto era necessário —
// e era essa a diferença entre o ensaio e a base.
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const LOCAL   = "44444444-4444-4444-8444-444444444444";
const SERVICO = "55555555-5555-4555-8555-555555555555";
const EQUIPA  = "66666666-6666-4666-8666-666666666666";

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
/**
 * 🔴 Deixou de ser escrito à mão — ver `helpers/production-baseline.ts`.
 *
 *    Tinha treze tabelas com colunas inventadas. Produção tem 47 e 93
 *    políticas. Era esse subconjunto que fazia estas provas serem verdadeiras
 *    sem serem suficientes.
 */
const BASELINE = () =>
  `DROP SCHEMA IF EXISTS public CASCADE;
   DROP SCHEMA IF EXISTS auth CASCADE;
   CREATE SCHEMA public;
   ${baselineCompleto()}`;

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
  await pool.query(BASELINE());
  await pool.query("INSERT INTO companies(id,name,slug) VALUES($1,'A','a'),($2,'B','b')",
    [EMPRESA_A, EMPRESA_B]);
  await pool.query("INSERT INTO clients(id,company_id,name) VALUES($1,$2,'Cliente')", [CLIENTE, EMPRESA_A]);
  await pool.query(
    "INSERT INTO locations(id,company_id,client_id,name,address) VALUES($1,$2,$3,'Local','Rua')",
    [LOCAL, EMPRESA_A, CLIENTE]);
  await pool.query(
    `INSERT INTO services(id,company_id,location_id,reference_number,scheduled_start,scheduled_end)
     VALUES($1,$2,$3,'S-1',now(),now())`, [SERVICO, EMPRESA_A, LOCAL]);
  await pool.query("INSERT INTO teams(id,company_id,name) VALUES($1,$2,'Equipa')", [EQUIPA, EMPRESA_A]);
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
      "INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary) VALUES($1,$2,2026,8,1200)",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO team_members(team_id,collaborator_id) VALUES($1,$2)", [EQUIPA, quem]);
    await pool.query(
      "INSERT INTO collaborator_documents(company_id,collaborator_id,file_name,file_url) VALUES($1,$2,'contrato.pdf','contrato.pdf')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO absences(company_id,collaborator_id,absence_type,starts_on,ends_on) VALUES($1,$2,'doenca','2026-08-26','2026-08-26')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO vacation_requests(company_id,collaborator_id,starts_on,ends_on) VALUES($1,$2,'2026-08-26','2026-08-27')",
      [EMPRESA_A, quem]);
    await pool.query("INSERT INTO timesheets(company_id,collaborator_id,service_id) VALUES($1,$2,$3)",
      [EMPRESA_A, quem, SERVICO]);
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
      payroll_records: "(company_id,collaborator_id,period_year,period_month,net_salary) VALUES($1,$2,2026,8,800)",
      absences: "(company_id,collaborator_id,absence_type,starts_on,ends_on) VALUES($1,$2,'doenca','2026-08-26','2026-08-26')",
      vacation_requests: "(company_id,collaborator_id,starts_on,ends_on) VALUES($1,$2,'2026-08-26','2026-08-27')",
      timesheets: `(company_id,collaborator_id,service_id) VALUES($1,$2,'${SERVICO}')`,
      collaborator_documents: "(company_id,collaborator_id,file_name,file_url) VALUES($1,$2,'c.pdf','c.pdf')",
    };
    const semEmpresa: Record<string, string> = {
      team_members: `(team_id,collaborator_id) VALUES('${EQUIPA}',$1)`,
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
      "INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary) VALUES($1,$2,2026,8,900)",
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
