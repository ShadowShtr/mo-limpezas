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

import { baselineCompleto } from "./helpers/production-baseline";

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
/**
 * 🔴 O baseline deixou de ser escrito à mão.
 *
 *    Esta constante tinha dez tabelas inventadas, com colunas que produção não
 *    tem (`horas`, `motivo`, `dia`, `titulo`) e duas das oito políticas reais
 *    de `timesheets`. Provava o desenho contra um mundo mais simples do que o
 *    nosso — e foi por isso que não viu que 71 políticas, e não 8, resolvem a
 *    identidade pela equivalência antiga.
 *
 *    Agora parte da forma real do schema, gerada por
 *    `scripts/dump-production-rls-baseline.mjs`.
 */
const BASELINE = () =>
  `DROP SCHEMA IF EXISTS public CASCADE;
   DROP SCHEMA IF EXISTS auth CASCADE;
   CREATE SCHEMA public;
   ${baselineCompleto()}`;

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
  await pool.query(BASELINE());
  await pool.query("INSERT INTO companies(id,name,slug) VALUES($1,'A','a'),($2,'B','b')",
    [EMPRESA_A, EMPRESA_B]);
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

  // Dados pessoais de cada uma das três, com as colunas que produção exige.
  const CLIENTE = randomUUID(), LOCAL = randomUUID(), SERVICO = randomUUID();
  await pool.query("INSERT INTO clients(id,company_id,name) VALUES($1,$2,'Cliente')",
    [CLIENTE, EMPRESA_A]);
  await pool.query(
    "INSERT INTO locations(id,company_id,client_id,name,address) VALUES($1,$2,$3,'Local','Rua')",
    [LOCAL, EMPRESA_A, CLIENTE]);
  await pool.query(
    `INSERT INTO services(id,company_id,location_id,reference_number,scheduled_start,scheduled_end)
     VALUES($1,$2,$3,'S-1',now(),now())`,
    [SERVICO, EMPRESA_A, LOCAL]);

  for (const quem of [colabA, colegaA, semConta]) {
    await pool.query(
      "INSERT INTO timesheets(company_id,collaborator_id,service_id) VALUES($1,$2,$3)",
      [EMPRESA_A, quem, SERVICO]);
    await pool.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month) VALUES($1,$2,2026,8)",
      [EMPRESA_A, quem]);
    await pool.query(
      `INSERT INTO absences(company_id,collaborator_id,absence_type,starts_on,ends_on)
       VALUES($1,$2,'doenca','2026-08-26','2026-08-26')`,
      [EMPRESA_A, quem]);
    await pool.query(
      "INSERT INTO daily_clocks(company_id,collaborator_id,work_date) VALUES($1,$2,'2026-08-26')",
      [EMPRESA_A, quem]);
    await pool.query(
      `INSERT INTO service_photos(company_id,service_id,collaborator_id,storage_path,client_event_id)
       VALUES($1,$2,$3,'f.jpg',gen_random_uuid())`,
      [EMPRESA_A, SERVICO, quem]);
    await pool.query(
      "INSERT INTO notifications(company_id,user_id,type,title) VALUES($1,$2,'aviso','Aviso')",
      [EMPRESA_A, quem]);
    await pool.query(
      `INSERT INTO push_subscriptions(company_id,user_id,endpoint,p256dh,auth_key)
       VALUES($1,$2,'https://e','k','a')`,
      [EMPRESA_A, quem]);
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
      c.query("UPDATE daily_clocks SET work_date='2026-01-01' WHERE collaborator_id=$1", [semConta]));
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
