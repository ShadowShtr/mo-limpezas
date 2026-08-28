/**
 * F14-C — o executor das 6, endurecido.
 *
 * Duas coisas mudam em relação ao que a #82 tinha:
 *
 *   · o `UPDATE` do forward passa a ser condicional a **todo** o estado
 *     economicamente relevante que o manifesto viu, não só a `amount`,
 *     `status`, `type` e `reference_*`;
 *   · o repair passa a registar proveniência `adopted_existing`, porque é
 *     exactamente o que está a fazer — adoptar um movimento que já existia.
 *
 * A matriz stale corre campo a campo: para cada um, altera-se **só** esse
 * campo entre o manifesto e a aplicação, e exige-se zero escritas.
 *
 * Requer Docker. Postgres 16 real — a atomicidade, o `ON DELETE RESTRICT` e a
 * conciliação não se reproduzem com um duplo em memória.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `f14c-hardened-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const OTHER_CATEGORY = "44444444-4444-4444-8444-444444444444";

let port = 0;
let pool: pg.Pool;
let dbUrl = "";

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

const readSql = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $auth$ SELECT NULL::uuid $auth$;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, auth_user_id uuid, role text);
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text,
    applied_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, color text);
  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    year integer NOT NULL, month integer NOT NULL,
    status text NOT NULL CHECK (status IN ('open','closed')),
    UNIQUE(company_id, year, month));
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')), description text NOT NULL,
    amount numeric(10,2), due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false, period_year integer NOT NULL,
    period_month integer NOT NULL, paid_at timestamptz, notes text,
    expense_category_id uuid, attachment_url text, attachment_name text,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')), amount numeric(10,2) NOT NULL,
    description text NOT NULL, category text, date date NOT NULL,
    reference_id uuid, reference_type text,
    status text NOT NULL CHECK (status IN ('pendente','confirmado')),
    expense_category_id uuid, notes text, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries(company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
  CREATE TABLE public.bank_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending');
  CREATE TABLE public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    match_score integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    parent_type text NOT NULL, parent_id uuid NOT NULL,
    storage_bucket text NOT NULL, storage_path text NOT NULL,
    original_name text NOT NULL);
  -- O resolver canónico: as políticas da 080 chamam-no.
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $gmc$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $gmc$;
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $gmr$ SELECT role FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $gmr$;
  -- Os papeis do Supabase: a 083 revoga-lhes privilegios e nao pode revogar
  -- de quem nao existe.
  DO $papeis$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $papeis$;
`;

/** As seis obrigações legadas, como vivem hoje no Fluxo de Caixa. */
const SEIS = [
  ["Fatura A", "100.00", "2026-07-10", null],
  ["Fatura B", "200.50", "2026-07-22", null],
  ["Fatura C", "300.25", "2026-08-03", CATEGORY],
  ["Fatura D", "400.00", "2026-08-07", null],
  ["Fatura E", "500.75", "2026-08-11", null],
  ["Fatura F", "600.00", "2026-08-19", null],
] as const;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14c" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* nunca abriu */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

async function reset() {
  await pool.query(BASELINE);
  await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
  await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
  // 🔴 A 080 e a 081, numeradas — já não são rascunhos. A 081 exige a linha
  //    da 080 no ledger, que é o que o runner escreveria.
  await pool.query(readSql("supabase", "migrations", "080_payment_cashflow_provenance.sql"));
  await pool.query(
    `INSERT INTO public._migrations(name, checksum)
     VALUES ('080_payment_cashflow_provenance.sql', 'ensaio')
     ON CONFLICT (name) DO NOTHING`);
  await pool.query(readSql("supabase", "migrations", "081_safe_unmark_payment_paid.sql"));

  // 🔴 A 083 tambem, porque ja esta em producao. A reparacao escreve
  //    directamente por PostgreSQL com a identidade de servico, que a 083
  //    preserva — mas isso prova-se a correr, nao a afirmar.
  await pool.query(readSql("supabase", "migrations", "083_payment_authorization_hardening.sql"));
  await pool.query(
    `INSERT INTO public._migrations(name, checksum)
     VALUES ('083_payment_authorization_hardening.sql', 'ensaio')
     ON CONFLICT (name) DO NOTHING`);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Empresa de ensaio')", [COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Fornecedores','violeta')",
    [CATEGORY, COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Outra','cinza')",
    [OTHER_CATEGORY, COMPANY]);
}

async function seedSeis() {
  const ids: string[] = [];
  for (const [description, amount, date, categoryId] of SEIS) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO cash_flow_entries
         (id,company_id,type,amount,description,category,date,status,expense_category_id,notes)
       VALUES($1,$2,'saida',$3,$4,'despesa',$5,'pendente',$6,'nota legada')`,
      [id, COMPANY, amount, description, date, categoryId]);
  }
  return ids;
}

function runExecutor(args: string[]) {
  return spawnSync(process.execPath, [
    path.join(ROOT, "scripts/repairs/six-pending-obligations.mjs"),
    "--database-url", dbUrl, ...args,
  ], { cwd: ROOT, encoding: "utf8" });
}

type Manifesto = {
  sha256: string;
  linhas: Array<{ legacy_cashflow_id: string; target_payment_id: string }>;
};

async function prepararManifesto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f14c-manifest-"));
  const dry = runExecutor(["--out", dir]);
  if (dry.status !== 0) throw new Error(`${dry.stdout}\n${dry.stderr}`);
  const forwardPath = path.join(dir, "six-forward.json");
  return {
    dir,
    forwardPath,
    rollbackPath: path.join(dir, "six-rollback.json"),
    forward: JSON.parse(fs.readFileSync(forwardPath, "utf8")) as Manifesto,
  };
}

const aplicar = (ctx: { forwardPath: string; forward: Manifesto }) =>
  runExecutor(["--apply", "--confirm-production", "ENSAIO-DESCARTAVEL",
    "--manifest", ctx.forwardPath, "--manifest-sha", ctx.forward.sha256]);

const contar = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].n);

const pagamentos = () => contar("SELECT count(*)::int n FROM fixed_variable_payments");
const provenienciasN = () => contar("SELECT count(*)::int n FROM payment_cashflow_provenance");
const ligados = () =>
  contar("SELECT count(*)::int n FROM cash_flow_entries WHERE reference_type='fixed_variable_payment'");

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=f14c",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "f14c", max: 12 });
  const protocolo = "postgres" + "ql";
  dbUrl = `${protocolo}://postgres@127.0.0.1:${port}/f14c`;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("F14-C — o forward regista a adopção", () => {
  it("o repair cria proveniência adopted_existing para as seis", async () => {
    await reset();
    const legados = await seedSeis();
    const ctx = await prepararManifesto();
    const r = aplicar(ctx);
    expect(r.status).toBe(0);

    expect(await pagamentos()).toBe(6);
    expect(await provenienciasN()).toBe(6);
    expect(await ligados()).toBe(6);

    // 🔴 O prestate guardado é o do movimento legado, e é o que o unmark
    //    precisa para o devolver ao que era.
    const prov = (await pool.query(
      `SELECT p.cash_flow_entry_id::text AS id, p.origin, p.prestate_date::text AS d,
              p.prestate_expense_category_id::text AS c
         FROM payment_cashflow_provenance p ORDER BY p.prestate_date`)).rows;
    expect(prov.map((x) => x.origin)).toEqual(Array(6).fill("adopted_existing"));
    expect(prov.map((x) => x.d)).toEqual(SEIS.map((s) => s[2]));
    expect(prov.map((x) => x.id).sort()).toEqual([...legados].sort());
  });

  it("nenhum movimento legado é criado nem apagado", async () => {
    await reset();
    const legados = await seedSeis();
    const antes = (await pool.query(
      "SELECT id::text, created_at FROM cash_flow_entries ORDER BY date")).rows;
    const ctx = await prepararManifesto();
    expect(aplicar(ctx).status).toBe(0);
    const depois = (await pool.query(
      "SELECT id::text, created_at FROM cash_flow_entries ORDER BY date")).rows;
    expect(depois).toEqual(antes);
    expect(depois.map((r) => r.id).sort()).toEqual([...legados].sort());
  });
});

describe.sequential("F14-C — matriz stale: cada campo, zero escritas", () => {
  const casos: Array<[string, string, unknown]> = [
    ["description", "UPDATE cash_flow_entries SET description=$2 WHERE id=$1", "Descrição nova"],
    ["date", "UPDATE cash_flow_entries SET date=$2 WHERE id=$1", "2026-09-30"],
    ["category", "UPDATE cash_flow_entries SET category=$2 WHERE id=$1", "fornecedor"],
    ["expense_category_id", "UPDATE cash_flow_entries SET expense_category_id=$2 WHERE id=$1", OTHER_CATEGORY],
    ["notes", "UPDATE cash_flow_entries SET notes=$2 WHERE id=$1", "Nota escrita depois"],
    ["amount", "UPDATE cash_flow_entries SET amount=$2 WHERE id=$1", "999.99"],
    ["status", "UPDATE cash_flow_entries SET status=$2 WHERE id=$1", "confirmado"],
    ["type", "UPDATE cash_flow_entries SET type=$2 WHERE id=$1", "entrada"],
  ];

  it.each(casos)("%s alterado depois do manifesto → recusa, zero escritas", async (_campo, sql, valor) => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    const alvo = ctx.forward.linhas[2].legacy_cashflow_id;
    await pool.query(sql, [alvo, valor]);

    const r = aplicar(ctx);
    expect(r.status).not.toBe(0);

    // 🔴 O lote inteiro reverte: nem os que estavam bons passam.
    expect(await pagamentos()).toBe(0);
    expect(await provenienciasN()).toBe(0);
    expect(await ligados()).toBe(0);
  });

  it("created_at alterado depois do manifesto → recusa", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    await pool.query("UPDATE cash_flow_entries SET created_at = created_at + interval '1 hour' WHERE id=$1",
      [ctx.forward.linhas[0].legacy_cashflow_id]);
    expect(aplicar(ctx).status).not.toBe(0);
    expect(await pagamentos()).toBe(0);
    expect(await provenienciasN()).toBe(0);
  });

  it("sem alterações, o mesmo manifesto aplica", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    expect(aplicar(ctx).status).toBe(0);
    expect(await pagamentos()).toBe(6);
  });
});

describe.sequential("F14-C — idempotência e colisão", () => {
  it("segunda aplicação: zero duplicados de pagamento, movimento e proveniência", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    expect(aplicar(ctx).status).toBe(0);

    const segunda = aplicar(ctx);
    expect(segunda.status).not.toBe(0);
    expect(await pagamentos()).toBe(6);
    expect(await provenienciasN()).toBe(6);
    expect(await ligados()).toBe(6);
  });

  it("um id de pagamento que já existe reverte o lote inteiro", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    await pool.query(
      `INSERT INTO fixed_variable_payments
         (id,company_id,kind,description,amount,status,recurring,period_year,period_month)
       VALUES($1,$2,'variavel','Colisão',10,'pendente',false,2026,7)`,
      [ctx.forward.linhas[4].target_payment_id, COMPANY]);

    expect(aplicar(ctx).status).not.toBe(0);
    // Só o intruso sobrevive; nenhuma proveniência fica órfã.
    expect(await pagamentos()).toBe(1);
    expect(await provenienciasN()).toBe(0);
    expect(await ligados()).toBe(0);
  });
});

describe.sequential("F14-C — ciclo completo com o mark/unmark endurecido", () => {
  it("repair → mark → unmark → mark preserva o id e a data legada", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    expect(aplicar(ctx).status).toBe(0);

    const linha = ctx.forward.linhas[0];
    const legacy = linha.legacy_cashflow_id;
    const pagamento = linha.target_payment_id;
    const dataLegada = (await pool.query(
      "SELECT date::text d FROM cash_flow_entries WHERE id=$1", [legacy])).rows[0].d;

    const estado = async () => (await pool.query(
      "SELECT id::text, status, date::text AS date FROM cash_flow_entries WHERE reference_id=$1",
      [pagamento])).rows;

    await pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
      [COMPANY, pagamento, "2026-09-15"]);
    expect(await estado()).toEqual([{ id: legacy, status: "confirmado", date: "2026-09-15" }]);

    await pool.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, pagamento]);
    // 🔴 Mesma linha, devolvida à data que tinha antes do repair.
    expect(await estado()).toEqual([{ id: legacy, status: "pendente", date: dataLegada }]);

    await pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
      [COMPANY, pagamento, "2026-09-20"]);
    expect(await estado()).toEqual([{ id: legacy, status: "confirmado", date: "2026-09-20" }]);

    expect(await ligados()).toBe(6);
    expect(await contar("SELECT count(*)::int n FROM cash_flow_entries")).toBe(6);
  });

  it("conciliado: desmarcar recusa e nada se move", async () => {
    await reset();
    await seedSeis();
    const ctx = await prepararManifesto();
    expect(aplicar(ctx).status).toBe(0);

    const { legacy_cashflow_id: legacy, target_payment_id: pagamento } = ctx.forward.linhas[1];
    await pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
      [COMPANY, pagamento, "2026-09-15"]);

    const tx = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id,status) VALUES($1,$2,'reconciled')",
      [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'confirmed')`, [COMPANY, tx, legacy]);

    await expect(pool.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, pagamento]))
      .rejects.toThrow(/UNMARK_BLOCKED_RECONCILED_CASHFLOW/);

    expect(await contar(
      "SELECT count(*)::int n FROM bank_reconciliation_matches WHERE cash_flow_entry_id=$1", [legacy])).toBe(1);
    expect(await contar("SELECT count(*)::int n FROM cash_flow_entries WHERE id=$1", [legacy])).toBe(1);
    expect(await contar(
      "SELECT count(*)::int n FROM bank_transactions WHERE id=$1 AND status='reconciled'", [tx])).toBe(1);
  });
});
