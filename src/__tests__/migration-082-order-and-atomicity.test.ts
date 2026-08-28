// ============================================================================
// 082 — atomicidade com o runner, e as duas ordens de aplicação
// ============================================================================
//
// Duas coisas que não se provam lendo o SQL.
//
// 1. **A transacção é do runner.** Ele faz
//    `BEGIN → SQL da migration → INSERT public._migrations → COMMIT`. Se a
//    migration abrir e fechar transacção própria, o `COMMIT` interno fecha a
//    dele mais cedo: a escrita no ledger passa a correr fora, e se falhar fica
//    o efeito de schema sem registo. É o `SCHEMA_EFFECT != MIGRATION_PROVENANCE`
//    que esta frente inteira existe para eliminar — e que já mordeu as
//    079/080/081.
//
// 2. **As duas ordens têm de dar o mesmo fim.** Produção já tem a 083 e não
//    tem a 082, portanto vai aplicar `083 → 082`. Uma instalação limpa aplica
//    `082 → 083`. Se a 082 dependesse da 083 para fechar as suas funções — que
//    é o que aconteceria sem a secção 7 —, as duas ordens divergiriam e a
//    ordem de produção seria a insegura.
//
// Tudo em PostgreSQL 17 real, com a versão perguntada ao servidor.
// ============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `mig082-${process.pid}`;
let port = 0;
let pool: pg.Pool;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const sql = (nome: string) => fs.readFileSync(path.join(ROOT, "supabase", "migrations", nome), "utf8");

const M073 = "073_payment_to_cashflow.sql";
const M079 = "079_reuse_pending_cashflow_on_payment.sql";
const M080 = "080_payment_cashflow_provenance.sql";
const M081 = "081_safe_unmark_payment_paid.sql";
const M082 = "082_atomic_finance_mutations.sql";
const M083 = "083_payment_authorization_hardening.sql";

/** As seis funções que a 082 cria. */
const FUNCOES_082 = [
  "public.update_payment_atomic(uuid, uuid, jsonb)",
  "public.delete_payment_atomic(uuid, uuid)",
  "public.lock_cashflow_for_manual_mutation(uuid, uuid)",
  "public.update_cashflow_entry_atomic(uuid, uuid, jsonb)",
  "public.delete_cashflow_entry_atomic(uuid, uuid)",
  "public.confirm_bank_match_atomic(uuid, uuid, uuid)",
];

const BASE = `
  DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $a$ SELECT NULL::uuid $a$;
  DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $p$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, auth_user_id uuid, role text);
  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, color text);
  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    year integer NOT NULL, month integer NOT NULL,
    status text NOT NULL CHECK (status IN ('open','closed')), UNIQUE(company_id, year, month));
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')), description text NOT NULL,
    amount numeric(10,2), due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false, period_year integer NOT NULL,
    period_month integer NOT NULL, paid_at timestamptz, notes text,
    expense_category_id uuid, attachment_url text, attachment_name text,
    direct_debit boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Produção tem estas duas; faltavam aqui e a RPC escreve-as.
    updated_at timestamptz NOT NULL DEFAULT now());
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
    status text NOT NULL DEFAULT 'pending', updated_at timestamptz);
  CREATE TABLE public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    match_score integer NOT NULL DEFAULT 0, match_reason text,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    confirmed_by uuid, confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $r$ SELECT role FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $r$;
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $c$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $c$;
`;

async function esperar() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "mig"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "mig" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const r = docker(["run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=mig",
    // Porta atribuída pelo Docker: intervalos reservados pelo Windows já
    // fizeram falhar ensaios por motivo alheio ao código.
    "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  if (r.status !== 0) throw new Error(`contentor: ${r.stderr || r.stdout}`);
  const m = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(m.slice(m.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${m}`);
  await esperar();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "mig", max: 4 });
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } catch { /* já fechada */ }
  docker(["rm", "-f", CONTAINER]);
});

/** Reproduz o que o runner faz por cada migration. */
async function aplicarComoRunner(c: pg.PoolClient, nome: string, forcarFalhaNoLedger = false) {
  await c.query("BEGIN");
  await c.query(sql(nome));
  await c.query("INSERT INTO public._migrations(name, checksum) VALUES($1,$2)",
    [forcarFalhaNoLedger ? "colisao" : nome, "x"]);
  await c.query("COMMIT");
}

async function preparar(c: pg.PoolClient) {
  await c.query(BASE);
  for (const m of [M073, M079, M080, M081]) {
    await c.query("BEGIN"); await c.query(sql(m));
    await c.query("INSERT INTO public._migrations(name, checksum) VALUES($1,'x')", [m]);
    await c.query("COMMIT");
  }
}

const podeExecutar = async (papel: string, f: string) => (await pool.query(
  "SELECT has_function_privilege($1,$2,'EXECUTE') p", [papel, f])).rows[0].p as boolean;

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("082 — o motor e a transacção", () => {
  it("🔴 corre em PostgreSQL 17, perguntado ao servidor", async () => {
    const { rows } = await pool.query("SELECT version() v, current_setting('server_version') sv");
    expect(rows[0].v).toMatch(/^PostgreSQL 17\./);
    expect(String(rows[0].sv).split(".")[0]).toBe("17");
  });

  it("🔴 o ficheiro não abre nem fecha transacção própria", () => {
    // A guarda de texto acompanha a de comportamento: se alguém reintroduzir um
    // `BEGIN;`, isto fica vermelho antes de ser preciso um contentor.
    const linhas = sql(M082).split("\n").map((l) => l.trim());
    expect(linhas.filter((l) => l === "BEGIN;")).toHaveLength(0);
    expect(linhas.filter((l) => l === "COMMIT;")).toHaveLength(0);
  });

  it("🔴 falha a escrever no ledger reverte as funções e as ACL", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      // Colide na chave primária do ledger — a escrita rebenta depois do SQL.
      await c.query("INSERT INTO public._migrations(name, checksum) VALUES('colisao','x')");

      let rebentou = false;
      try { await aplicarComoRunner(c, M082, true); }
      catch { rebentou = true; await c.query("ROLLBACK"); }
      expect(rebentou, "a escrita no ledger devia ter falhado").toBe(true);

      // Nenhuma das seis sobreviveu, e o ledger não ganhou a 082.
      for (const f of FUNCOES_082) {
        const { rows } = await c.query("SELECT to_regprocedure($1) IS NOT NULL e", [f]);
        expect(rows[0].e, f).toBe(false);
      }
      const { rows: led } = await c.query(
        "SELECT count(*)::int n FROM public._migrations WHERE name=$1", [M082]);
      expect(led[0].n).toBe(0);
    } finally { c.release(); }
  }, 120_000);

  it("e no caminho feliz ficam as duas coisas: funções e registo", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M082);
      for (const f of FUNCOES_082) {
        const { rows } = await c.query("SELECT to_regprocedure($1) IS NOT NULL e", [f]);
        expect(rows[0].e, f).toBe(true);
      }
      const { rows: led } = await c.query(
        "SELECT count(*)::int n FROM public._migrations WHERE name=$1", [M082]);
      expect(led[0].n).toBe(1);
    } finally { c.release(); }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("as duas ordens dão a mesma superfície", () => {
  /** Fotografia da autorização: o que interessa comparar entre as ordens. */
  async function superficie() {
    const funcoes: Record<string, Record<string, boolean>> = {};
    const todas = [...FUNCOES_082,
      "public.mark_payment_paid(uuid, uuid, date)",
      "public.unmark_payment_paid(uuid, uuid)"];
    for (const f of todas) {
      funcoes[f] = {};
      for (const papel of ["public", "anon", "authenticated", "service_role"]) {
        funcoes[f][papel] = await podeExecutar(papel, f);
      }
    }
    const tabela: Record<string, boolean> = {};
    for (const papel of ["public", "anon", "authenticated", "service_role"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        tabela[`${papel}:${p}`] = (await pool.query(
          "SELECT has_table_privilege($1,'public.fixed_variable_payments',$2) p", [papel, p]
        )).rows[0].p;
      }
    }
    return { funcoes, tabela };
  }

  let limpa: Awaited<ReturnType<typeof superficie>>;
  let producao: Awaited<ReturnType<typeof superficie>>;

  it("CLEAN_ORDER_082_083: instalação limpa aplica 082 e depois 083", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M082);
      await aplicarComoRunner(c, M083);
    } finally { c.release(); }
    limpa = await superficie();
    for (const f of FUNCOES_082) {
      expect(await podeExecutar("public", f), f).toBe(false);
      expect(await podeExecutar("authenticated", f), f).toBe(false);
      expect(await podeExecutar("service_role", f), f).toBe(true);
    }
  }, 120_000);

  it("PRODUCTION_ORDER_083_082: produção já tem a 083 e aplica só a 082", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      // O estado real de produção: 083 aplicada, 082 ausente.
      await aplicarComoRunner(c, M083);
      const { rows } = await c.query(
        "SELECT count(*)::int n FROM public._migrations WHERE name IN ($1,$2)", [M083, M082]);
      expect(rows[0].n, "só a 083 devia estar no ledger").toBe(1);

      // E agora só a 082, pelo runner. Sem baseline, sem ledger forjado.
      await aplicarComoRunner(c, M082);
    } finally { c.release(); }
    producao = await superficie();

    for (const f of FUNCOES_082) {
      expect(await podeExecutar("public", f), f).toBe(false);
      expect(await podeExecutar("anon", f), f).toBe(false);
      expect(await podeExecutar("authenticated", f), f).toBe(false);
      expect(await podeExecutar("service_role", f), f).toBe(true);
    }
  }, 120_000);

  it("🔴 FINAL_AUTH_EQUIVALENCE: as duas ordens terminam iguais", async () => {
    // É esta a asserção que importa. Se a 082 dependesse da 083 para fechar as
    // suas funções, a ordem de produção — 083 primeiro — deixá-las-ia abertas,
    // e só esta comparação o mostraria.
    expect(producao).toEqual(limpa);
  });

  it("a escrita directa na tabela continua fechada, e a leitura do gestor aberta", async () => {
    for (const papel of ["public", "anon", "authenticated"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        expect(producao.tabela[`${papel}:${p}`], `${papel}:${p}`).toBe(false);
      }
    }
    expect(producao.tabela["authenticated:SELECT"]).toBe(true);
    expect(producao.tabela["anon:SELECT"]).toBe(false);
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(producao.tabela[`service_role:${p}`], p).toBe(true);
    }
  });
});
