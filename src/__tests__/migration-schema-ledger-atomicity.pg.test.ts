/**
 * Atomicidade entre EFEITO DE SCHEMA e PROVENANCE NO LEDGER.
 *
 * O runner (scripts/lib/migration-runner-core.mjs) é a transação autoritativa:
 *
 *   BEGIN -> executar o .sql -> INSERT public._migrations -> COMMIT
 *
 * Uma migration que traga `BEGIN;`/`COMMIT;` próprios fecha essa transação a
 * meio. O efeito de schema fica commitado, o INSERT do ledger passa a correr
 * noutra transação implícita, e o `ROLLBACK` do catch do runner vira no-op.
 * Resultado: SCHEMA_EFFECT = YES com MIGRATION_PROVENANCE = NO.
 *
 * Este ficheiro não testa "a migration corre". Testa a metade que interessa:
 * quando o INSERT do ledger falha, o efeito de schema TEM de desaparecer.
 *
 * Corre o runner REAL — não uma reimplementação — contra Postgres 16 real em
 * Docker, com um cliente que intercepta apenas o INSERT no ledger.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";

const ROOT = process.cwd();
const CONTAINER = `mig-atomic-${process.pid}`;
let port = 0;

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * Pré-condição de schema. Deliberadamente o MESMO desenho de
 * `reuse-pending-cashflow-rpc.test.ts` — se a base do ensaio divergir da que
 * já prova o comportamento da 079, os dois ficheiros deixam de falar da mesma
 * coisa e um deles passa a mentir.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);

  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL, name text NOT NULL, color text);

  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    year smallint NOT NULL,
    month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month));

  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')),
    amount numeric(10,2) NOT NULL,
    description text NOT NULL,
    category text DEFAULT 'outro'
      CHECK (category IN ('faturacao','salario','despesa','fornecedor','outro')),
    date date NOT NULL,
    reference_id uuid,
    reference_type text,
    status text NOT NULL DEFAULT 'confirmado'
      CHECK (status IN ('pendente','confirmado')),
    notes text,
    created_by uuid,
    created_at timestamptz DEFAULT now(),
    expense_category_id uuid);

  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')),
    description text NOT NULL,
    amount numeric(10,2),
    due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false,
    period_year integer NOT NULL,
    period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    paid_at timestamptz,
    notes text,
    created_at timestamptz DEFAULT now(),
    expense_category_id uuid);

  -- As políticas RLS da 080 resolvem a identidade por get_my_company_id(),
  -- criada na 014. Reproduz-se a mesma definição (e o auth.uid() de que
  -- depende) para o ensaio ter a pré-condição real, não uma imitação.
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $u$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, role text);
  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $g$ SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $g$;
`;

/** As migrations anteriores de que a 079 depende, na ordem real. */
const PREVIAS = [
  "024_cash_flow_reference_integrity.sql",
  "049_cash_flow_service_payment_reference.sql",
  "075_cash_flow_fixed_variable_payment_reference.sql",
  "073_payment_to_cashflow.sql",
];

async function waitForPostgres() {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch {
      try { await c.end(); } catch { /* noop */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Postgres não ficou pronto");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=atomic",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
}, 180_000);

afterAll(() => {
  docker(["rm", "-f", CONTAINER]);
});

/**
 * Cliente que deixa passar tudo excepto o INSERT no ledger, que rebenta como
 * rebentaria uma falha real (constraint, permissão, disco). É o gatilho do
 * cenário adversarial — nada mais é alterado.
 */
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

/** Cada caso corre isolado: baseline limpo, dir só com as migrations pedidas. */
async function preparar(migrations: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "mig-atomic-"));
  for (const m of migrations) {
    writeFileSync(join(dir, m), readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
  await client.connect();
  await client.query(BASELINE);
  // As prévias entram fora do runner: são a pré-condição, não o que se ensaia.
  for (const m of PREVIAS) {
    await client.query(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
  return { dir, client };
}

const silencio = { log: () => {}, logWarn: () => {}, logError: () => {} };

/** Objetos que cada migration cria — a assinatura observável do efeito de schema. */
async function funcoesExistentes(client: pg.Client, nomes: string[]) {
  const { rows } = await client.query(
    `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = ANY($1)`,
    [nomes],
  );
  return new Set(rows.map((r: { proname: string }) => r.proname));
}

/**
 * Hash da definição instalada. É esta a sonda certa e não a mera existência:
 * a 073 já está em produção e já criou `mark_payment_paid`/`unmark_payment_paid`,
 * por isso 079 e 081 são `CREATE OR REPLACE`. "A função existe" não distingue
 * a versão antiga da nova — o texto instalado distingue.
 */
async function defHash(client: pg.Client, nome: string): Promise<string | null> {
  const { rows } = await client.query(
    `select md5(pg_get_functiondef(p.oid)) h from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`,
    [nome],
  );
  return rows.length === 0 ? null : rows.map((r: { h: string }) => r.h).sort().join(",");
}

async function ledgerNomes(client: pg.Client) {
  const existe = await client.query("select to_regclass('public._migrations') as reg");
  if (!existe.rows[0].reg) return [];
  const { rows } = await client.query("select name from public._migrations order by name");
  return rows.map((r: { name: string }) => r.name);
}

describe.sequential("Atomicidade schema ↔ ledger no runner", () => {
  it("079: nenhum BEGIN;/COMMIT; de topo — a transação é a do runner", () => {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"), "utf8");
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
    // ...e os corpos PL/pgSQL continuam lá: não foi um replace cego.
    expect(sql).toContain("$guard$");
    expect(sql).toContain("$fn$");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.assert_payment_cashflow_link");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.mark_payment_paid");
  });

  it("079 caminho feliz: schema E ledger commitam juntos", async () => {
    const { dir, client } = await preparar(["079_reuse_pending_cashflow_on_payment.sql"]);
    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(0);
    const fns = await funcoesExistentes(client, ["assert_payment_cashflow_link", "mark_payment_paid"]);
    expect(fns.has("assert_payment_cashflow_link")).toBe(true);
    expect(fns.has("mark_payment_paid")).toBe(true);
    expect(await ledgerNomes(client)).toContain("079_reuse_pending_cashflow_on_payment.sql");
    await client.end();
  }, 120_000);

  it("079 ADVERSARIAL: ledger INSERT falha ⇒ efeito de schema revertido", async () => {
    const { dir, client } = await preparar(["079_reuse_pending_cashflow_on_payment.sql"]);
    // Estado pré-079 (o que produção tem hoje, com a 073): a guarda do F14-A
    // ainda não existe e a mark_payment_paid é a versão da 073.
    expect(await defHash(client, "assert_payment_cashflow_link")).toBeNull();
    const markAntes = await defHash(client, "mark_payment_paid");
    expect(markAntes).not.toBeNull();

    const { exitCode } = await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(1);

    // 🔴 O coração da prova: sem provenance, não pode ficar efeito de schema.
    expect(await defHash(client, "assert_payment_cashflow_link")).toBeNull();
    expect(await defHash(client, "mark_payment_paid")).toBe(markAntes);
    expect(await ledgerNomes(client)).not.toContain("079_reuse_pending_cashflow_on_payment.sql");
    await client.end();
  }, 120_000);
});

const M079 = "079_reuse_pending_cashflow_on_payment.sql";
const M080 = "080_payment_cashflow_provenance.sql";
const M081 = "081_safe_unmark_payment_paid.sql";

async function tabelaExiste(client: pg.Client, nome: string) {
  const { rows } = await client.query("select to_regclass($1) as reg", [nome]);
  return rows[0].reg !== null;
}

describe.sequential("080 e 081 — duas migrations, atomicidade por migration", () => {
  it("080 e 081 não têm BEGIN;/COMMIT; de topo, e mantêm-se separadas", () => {
    const sql080 = readFileSync(join(ROOT, "supabase", "migrations", M080), "utf8");
    const sql081 = readFileSync(join(ROOT, "supabase", "migrations", M081), "utf8");
    for (const sql of [sql080, sql081]) {
      expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
      expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
    }
    // 080 continua a criar a tabela, o índice único, RLS e as políticas.
    expect(sql080).toContain("CREATE TABLE IF NOT EXISTS public.payment_cashflow_provenance");
    expect(sql080).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql080).toContain("CREATE POLICY payment_cashflow_provenance_select");
    // 081 continua a ser a que muda comportamento — e o DO $dep$ sobreviveu.
    expect(sql081).toContain("DO $dep$");
    expect(sql081).toContain("$dep$;");
    expect(sql081).toContain("REQUIRED_MIGRATION_080_NOT_APPLIED");
    expect(sql081).toContain("CREATE OR REPLACE FUNCTION public.unmark_payment_paid");
  });

  it("080 caminho feliz: tabela E ledger commitam juntos", async () => {
    const { dir, client } = await preparar([M079, M080]);
    const { exitCode } = await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio });
    expect(exitCode).toBe(0);
    expect(await tabelaExiste(client, "public.payment_cashflow_provenance")).toBe(true);
    expect(await ledgerNomes(client)).toContain(M080);
    await client.end();
  }, 120_000);

  it("080 ADVERSARIAL: ledger INSERT falha ⇒ tabela/índice/policy revertidos", async () => {
    // A 079 entra primeiro pelo caminho normal; só a 080 encontra o ledger partido.
    const { dir, client } = await preparar([M079]);
    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);

    const dir080 = mkdtempSync(join(tmpdir(), "mig-atomic-080-"));
    writeFileSync(join(dir080, M080), readFileSync(join(ROOT, "supabase", "migrations", M080), "utf8"));
    const { exitCode } = await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir080, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(1);

    expect(await tabelaExiste(client, "public.payment_cashflow_provenance")).toBe(false);
    expect(await ledgerNomes(client)).not.toContain(M080);
    await client.end();
  }, 120_000);

  it("081 ADVERSARIAL: ledger INSERT falha ⇒ funções voltam à versão pré-081", async () => {
    const { dir, client } = await preparar([M079, M080]);
    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);

    // Definições instaladas ANTES da 081 (unmark vem da 073, mark da 079).
    const unmarkAntes = await defHash(client, "unmark_payment_paid");
    const markAntes = await defHash(client, "mark_payment_paid");
    expect(unmarkAntes).not.toBeNull();

    const dir081 = mkdtempSync(join(tmpdir(), "mig-atomic-081-"));
    writeFileSync(join(dir081, M081), readFileSync(join(ROOT, "supabase", "migrations", M081), "utf8"));
    const { exitCode } = await runMigrations({
      client: clientQueFalhaNoLedger(client) as unknown as pg.Client,
      migrationsDir: dir081, rootDir: ROOT, apply: true, ...silencio,
    });
    expect(exitCode).toBe(1);

    // 🔴 Nenhuma das duas redefinições da 081 pode ter sobrevivido.
    expect(await defHash(client, "unmark_payment_paid")).toBe(unmarkAntes);
    expect(await defHash(client, "mark_payment_paid")).toBe(markAntes);
    expect(await ledgerNomes(client)).not.toContain(M081);
    await client.end();
  }, 120_000);
});

/**
 * O estado intermédio que a direção aceitou explicitamente:
 * 080 aplicada + registada, 081 ausente. Tem de ser um estado SÃO —
 * não um meio-caminho que parte o runtime publicado.
 */
describe.sequential("080 sozinha — expand compatível com o runtime pré-081", () => {
  it("079+080 aplicadas, 081 ausente: ledger exacto e runtime pré-081 intacto", async () => {
    const { dir, client } = await preparar([M079, M080]);
    const { exitCode } = await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio });
    expect(exitCode).toBe(0);

    // INTERMEDIATE_080_LEDGER_STATE
    const ledger = await ledgerNomes(client);
    expect(ledger).toContain(M079);
    expect(ledger).toContain(M080);
    expect(ledger).not.toContain(M081);

    // A 080 é expand: acrescenta a tabela, não toca nas funções da 079.
    expect(await tabelaExiste(client, "public.payment_cashflow_provenance")).toBe(true);
    const fns = await funcoesExistentes(client, ["mark_payment_paid", "assert_payment_cashflow_link", "unmark_payment_paid"]);
    expect(fns.has("mark_payment_paid")).toBe(true);
    expect(fns.has("assert_payment_cashflow_link")).toBe(true);
    // 🔴 unmark_payment_paid existe desde a 073 — o que NÃO pode acontecer é a
    //    081 já ter corrido. A 080 é expand: não redefine funções. A prova de
    //    que estas definições são mesmo as pré-081 está no caso seguinte.
    expect(fns.has("unmark_payment_paid")).toBe(true);

    // E o comportamento pré-081 continua a funcionar de ponta a ponta:
    // marcar como pago cria o movimento, exactamente como antes da 080.
    const COMPANY = "11111111-1111-4111-8111-111111111111";
    await client.query("INSERT INTO public.companies(id,name) VALUES($1,'A')", [COMPANY]);
    const pay = await client.query(
      `INSERT INTO public.fixed_variable_payments
         (company_id, kind, description, amount, status, due_date, period_year, period_month)
       VALUES($1,'fixo','agua',100.00,'pendente',CURRENT_DATE,2026,8) RETURNING id`, [COMPANY]);
    const payId = pay.rows[0].id;

    await client.query("SELECT public.mark_payment_paid($1,$2,$3)", [COMPANY, payId, new Date().toISOString().slice(0, 10)]);

    const mov = await client.query(
      `select status, type, amount from public.cash_flow_entries
        where reference_type='fixed_variable_payment' and reference_id=$1`, [payId]);
    expect(mov.rowCount).toBe(1);
    expect(mov.rows[0].status).toBe("confirmado");
    expect(mov.rows[0].type).toBe("saida");
    expect(Number(mov.rows[0].amount)).toBe(100);

    const p = await client.query("select status from public.fixed_variable_payments where id=$1", [payId]);
    expect(p.rows[0].status).toBe("pago");

    // A tabela de proveniência existe e está vazia — quem a escreve é a 081.
    const prov = await client.query("select count(*)::int n from public.payment_cashflow_provenance");
    expect(prov.rows[0].n).toBe(0);
    await client.end();
  }, 120_000);

  it("a 081 muda mesmo as funções — logo o estado 080-sozinha é distinguível", async () => {
    // Sem este caso, "as funções estão na versão pré-081" seria uma afirmação
    // sem contraste: só se prova que são as antigas se a 081 as mudar mesmo.
    const a = await preparar([M079, M080]);
    expect((await runMigrations({ client: a.client, migrationsDir: a.dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);
    const semA081 = {
      mark: await defHash(a.client, "mark_payment_paid"),
      unmark: await defHash(a.client, "unmark_payment_paid"),
    };
    await a.client.end();

    const b = await preparar([M079, M080, M081]);
    expect((await runMigrations({ client: b.client, migrationsDir: b.dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);
    expect(await ledgerNomes(b.client)).toContain(M081);
    expect(await defHash(b.client, "mark_payment_paid")).not.toBe(semA081.mark);
    expect(await defHash(b.client, "unmark_payment_paid")).not.toBe(semA081.unmark);
    await b.client.end();
  }, 180_000);

  it("081 falha fechado se a 080 não estiver REGISTADA no ledger", async () => {
    // Efeito de schema da 080 presente, linha de ledger ausente — exactamente
    // o estado que a atomicidade quebrada produzia. A 081 tem de recusar.
    const { dir, client } = await preparar([M079, M080]);
    expect((await runMigrations({ client, migrationsDir: dir, rootDir: ROOT, apply: true, ...silencio })).exitCode).toBe(0);
    await client.query("DELETE FROM public._migrations WHERE name = $1", [M080]);

    let erro = "";
    try {
      await client.query(readFileSync(join(ROOT, "supabase", "migrations", M081), "utf8"));
    } catch (e) {
      erro = (e as Error).message;
    }
    expect(erro).toContain("REQUIRED_MIGRATION_080_NOT_APPLIED");
    await client.end();
  }, 120_000);
});
