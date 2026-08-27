// ============================================================================
// TOCTOU financeiro — a guarda e a escrita na mesma transacção
// ============================================================================
//
// Estes ensaios não testam validação: testam **corridas**. Cada um abre duas
// ligações reais ao PostgreSQL e força as duas operações a cruzarem-se no
// intervalo exacto em que a versão anterior perdia dinheiro.
//
// A forma é sempre a mesma, e é a única que prova alguma coisa:
//
//   1. A abre transacção e entra na função, que tranca a linha;
//   2. B tenta a operação concorrente e **bloqueia** no mesmo lock;
//   3. A faz COMMIT;
//   4. B acorda e vê o estado já escrito — e decide sobre ele, não sobre o
//      estado que leu antes de esperar.
//
// Sem o passo 2 não há prova nenhuma: duas operações que nunca se encontram
// passam sempre, e foi assim que a corrida sobreviveu à revisão.
//
// 🔴 O `pg_sleep` não entra aqui. Sincronizar por tempo dá um ensaio que passa
//    numa máquina rápida e falha noutra, e que passa sem o lock existir. A
//    espera é medida no próprio PostgreSQL, em `pg_locks`.
// ============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `atomic-fin-${process.pid}`;
const EMPRESA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

let port = 0;
let pool: pg.Pool;

const docker = (args: string[]) => spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
const readSql = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $a$ SELECT NULL::uuid $a$;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, auth_user_id uuid);
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
    match_score integer NOT NULL DEFAULT 0, match_reason text,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    confirmed_by uuid, confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text,
    applied_at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $g$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $g$;
`;

async function esperarPronto() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "atomic"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "atomic" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  port = 55900 + (process.pid % 300);
  docker(["rm", "-f", CONTAINER]);
  const r = docker(["run", "-d", "--name", CONTAINER,
    // `trust` num contentor local e descartável: uma credencial literal aqui
    // ficaria versionada, e o scanner de segredos recusa — com razão.
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=atomic",
    "-p", `${port}:5432`, "postgres:16-alpine"]);
  if (r.status !== 0) throw new Error(`contentor: ${r.stderr || r.stdout}`);
  await esperarPronto();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "atomic", max: 8 });
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } catch { /* já fechada */ }
  docker(["rm", "-f", CONTAINER]);
});

async function reset() {
  await pool.query(BASELINE);
  await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
  await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
  await pool.query(readSql("supabase", "migrations", "080_payment_cashflow_provenance.sql"));
  await pool.query(
    `INSERT INTO public._migrations(name, checksum)
     VALUES ('080_payment_cashflow_provenance.sql', 'ensaio')`);
  await pool.query(readSql("supabase", "migrations", "081_safe_unmark_payment_paid.sql"));
  await pool.query(readSql("supabase", "migrations", "082_atomic_finance_mutations.sql"));
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Ensaio')", [EMPRESA]);
  await pool.query(
    `INSERT INTO financial_periods(company_id, year, month, status)
     VALUES($1, 2026, 8, 'open')`, [EMPRESA]);
}

beforeEach(reset);

/** Um pagamento pendente, sem movimento ligado. */
async function pagamento(amount = "100.00") {
  const { rows } = await pool.query(
    `INSERT INTO fixed_variable_payments
       (company_id, kind, description, amount, period_year, period_month)
     VALUES ($1,'fixo','Fornecedor',$2,2026,8) RETURNING id::text`, [EMPRESA, amount]);
  return rows[0].id as string;
}

/** Um movimento manual, sem origem — o único tipo que se edita à mão. */
async function movimentoManual() {
  const { rows } = await pool.query(
    `INSERT INTO cash_flow_entries
       (company_id, type, amount, description, category, date, status)
     VALUES ($1,'saida',50.00,'Manual','despesa','2026-08-10','confirmado')
     RETURNING id::text`, [EMPRESA]);
  return rows[0].id as string;
}

async function correspondenciaSugerida(entryId: string) {
  const { rows: bt } = await pool.query(
    "INSERT INTO bank_transactions(company_id) VALUES($1) RETURNING id::text", [EMPRESA]);
  const { rows } = await pool.query(
    `INSERT INTO bank_reconciliation_matches
       (company_id, bank_transaction_id, cash_flow_entry_id, status)
     VALUES ($1,$2,$3,'suggested') RETURNING id::text`,
    [EMPRESA, bt[0].id, entryId]);
  return rows[0].id as string;
}

/**
 * Espera que `pid` esteja mesmo **bloqueado** à espera de um lock.
 *
 * 🔴 É este o coração do ensaio. Sem confirmar o bloqueio, um teste que passa
 *    não distingue «serializou» de «as duas operações nunca se encontraram».
 */
async function esperarBloqueado(pid: number) {
  const limite = Date.now() + 15_000;
  while (Date.now() < limite) {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid]);
    if (rows[0].n > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("A segunda operação nunca bloqueou — não há lock partilhado.");
}

/** Corre `fn` numa ligação própria, devolvendo também o pid do backend. */
async function ligacao() {
  const c = await pool.connect();
  const { rows } = await c.query("SELECT pg_backend_pid()::int AS pid");
  return { c, pid: rows[0].pid as number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pagamentos vs. marcação
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("pagamentos — a guarda e a escrita não se separam", () => {
  it("PAYMENT_AMOUNT_VS_MARK_CONCURRENT: o valor nunca diverge do movimento", async () => {
    const id = await pagamento("100.00");

    const a = await ligacao();
    const b = await ligacao();
    try {
      // A entra na marcação e tranca a linha do pagamento.
      await a.c.query("BEGIN");
      await a.c.query("SELECT * FROM mark_payment_paid($1,$2,$3)", [EMPRESA, id, "2026-08-15"]);

      // B tenta alterar o valor. Tem de esperar — é o mesmo lock.
      const bPromise = b.c.query(
        "SELECT * FROM update_payment_amount_atomic($1,$2,$3)", [EMPRESA, id, "999.00"],
      ).then(() => "escreveu").catch((e: Error) => e.message);

      await esperarBloqueado(b.pid);
      await a.c.query("COMMIT");

      // B acorda e decide sobre o estado real, não sobre o que leu antes.
      expect(await bPromise).toMatch(/PAYMENT_ALREADY_PAID|PAYMENT_LINKED_TO_CASHFLOW/);

      // 🔴 A invariante: valor do pagamento e valor do movimento continuam iguais.
      const { rows } = await pool.query(
        `SELECT p.amount::text AS pago, c.amount::text AS mov
           FROM fixed_variable_payments p
           JOIN cash_flow_entries c
             ON c.reference_type='fixed_variable_payment' AND c.reference_id=p.id
          WHERE p.id=$1`, [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].pago).toBe(rows[0].mov);
      expect(rows[0].pago).toBe("100.00");
    } finally {
      try { await a.c.query("ROLLBACK"); } catch { /* já terminou */ }
      a.c.release(); b.c.release();
    }
  }, 60_000);

  it("PAYMENT_DELETE_VS_MARK_CONCURRENT: não sobra movimento órfão", async () => {
    const id = await pagamento("100.00");

    const a = await ligacao();
    const b = await ligacao();
    try {
      await a.c.query("BEGIN");
      await a.c.query("SELECT * FROM mark_payment_paid($1,$2,$3)", [EMPRESA, id, "2026-08-15"]);

      const bPromise = b.c.query(
        "SELECT * FROM delete_payment_atomic($1,$2)", [EMPRESA, id],
      ).then(() => "apagou").catch((e: Error) => e.message);

      await esperarBloqueado(b.pid);
      await a.c.query("COMMIT");

      expect(await bPromise).toMatch(/PAYMENT_ALREADY_PAID|PAYMENT_LINKED_TO_CASHFLOW/);

      // 🔴 Nenhum movimento a apontar para um pagamento que já não existe.
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM cash_flow_entries c
          WHERE c.reference_type='fixed_variable_payment'
            AND NOT EXISTS (SELECT 1 FROM fixed_variable_payments p WHERE p.id=c.reference_id)`);
      expect(rows[0].n).toBe(0);
    } finally {
      try { await a.c.query("ROLLBACK"); } catch { /* já terminou */ }
      a.c.release(); b.c.release();
    }
  }, 60_000);

  it("sem concorrência, alterar e apagar um pagamento livre continua a funcionar", async () => {
    const id = await pagamento("100.00");
    await pool.query("SELECT * FROM update_payment_amount_atomic($1,$2,$3)", [EMPRESA, id, "250.00"]);
    const { rows } = await pool.query(
      "SELECT amount::text a FROM fixed_variable_payments WHERE id=$1", [id]);
    expect(rows[0].a).toBe("250.00");

    const { rows: del } = await pool.query(
      "SELECT apagados FROM delete_payment_atomic($1,$2)", [EMPRESA, id]);
    expect(del[0].apagados).toBe(1);
  });

  it("um pagamento de outra empresa não é alcançável", async () => {
    const id = await pagamento();
    await expect(
      pool.query("SELECT * FROM update_payment_amount_atomic($1,$2,$3)",
        ["44444444-4444-4444-8444-444444444444", id, "1.00"]),
    ).rejects.toThrow(/PAYMENT_NOT_FOUND/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Movimentos vs. conciliação
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("movimentos — a conciliação entra no mesmo protocolo", () => {
  it("CASHFLOW_UPDATE_VS_RECONCILE_CONCURRENT: não se altera um conciliado", async () => {
    const entry = await movimentoManual();
    const match = await correspondenciaSugerida(entry);

    const a = await ligacao();
    const b = await ligacao();
    try {
      // A confirma a conciliação e tranca o movimento pelo caminho novo.
      await a.c.query("BEGIN");
      await a.c.query("SELECT * FROM confirm_bank_match_atomic($1,$2,$3)", [EMPRESA, match, ACTOR]);

      const bPromise = b.c.query(
        "SELECT * FROM update_cashflow_entry_atomic($1,$2,$3::jsonb)",
        [EMPRESA, entry, JSON.stringify({ amount: "999.00" })],
      ).then(() => "alterou").catch((e: Error) => e.message);

      await esperarBloqueado(b.pid);
      await a.c.query("COMMIT");

      expect(await bPromise).toMatch(/CASHFLOW_RECONCILED/);

      const { rows } = await pool.query(
        "SELECT amount::text a FROM cash_flow_entries WHERE id=$1", [entry]);
      expect(rows[0].a).toBe("50.00");
    } finally {
      try { await a.c.query("ROLLBACK"); } catch { /* já terminou */ }
      a.c.release(); b.c.release();
    }
  }, 60_000);

  it("CASHFLOW_DELETE_VS_RECONCILE_CONCURRENT: não se apaga um conciliado", async () => {
    const entry = await movimentoManual();
    const match = await correspondenciaSugerida(entry);

    const a = await ligacao();
    const b = await ligacao();
    try {
      await a.c.query("BEGIN");
      await a.c.query("SELECT * FROM confirm_bank_match_atomic($1,$2,$3)", [EMPRESA, match, ACTOR]);

      const bPromise = b.c.query(
        "SELECT * FROM delete_cashflow_entry_atomic($1,$2)", [EMPRESA, entry],
      ).then(() => "apagou").catch((e: Error) => e.message);

      await esperarBloqueado(b.pid);
      await a.c.query("COMMIT");

      expect(await bPromise).toMatch(/CASHFLOW_RECONCILED/);

      // 🔴 O movimento ficou, e a correspondência confirmada continua a
      //    apontar para uma linha que existe. O CASCADE nunca chegou a correr.
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM cash_flow_entries WHERE id=$1) AS mov,
                (SELECT count(*)::int FROM bank_reconciliation_matches
                  WHERE cash_flow_entry_id=$1 AND status='confirmed') AS conc`, [entry]);
      expect(rows[0]).toEqual({ mov: 1, conc: 1 });
    } finally {
      try { await a.c.query("ROLLBACK"); } catch { /* já terminou */ }
      a.c.release(); b.c.release();
    }
  }, 60_000);

  it("um movimento com origem não se edita à mão, nem sem concorrência", async () => {
    const id = await pagamento();
    await pool.query("SELECT * FROM mark_payment_paid($1,$2,$3)", [EMPRESA, id, "2026-08-15"]);
    const { rows } = await pool.query(
      "SELECT id::text FROM cash_flow_entries WHERE reference_id=$1", [id]);

    await expect(
      pool.query("SELECT * FROM update_cashflow_entry_atomic($1,$2,$3::jsonb)",
        [EMPRESA, rows[0].id, JSON.stringify({ amount: "1.00" })]),
    ).rejects.toThrow(/CASHFLOW_MANAGED_BY_ORIGIN/);
  });

  it("o patch não deixa passar campos fora da lista branca", async () => {
    const entry = await movimentoManual();
    await expect(
      pool.query("SELECT * FROM update_cashflow_entry_atomic($1,$2,$3::jsonb)",
        [EMPRESA, entry, JSON.stringify({ company_id: EMPRESA, reference_type: "x" })]),
    ).rejects.toThrow(/CASHFLOW_FIELD_NOT_EDITABLE/);
  });

  it("sem conciliação, alterar e apagar um movimento manual continua a funcionar", async () => {
    const entry = await movimentoManual();
    await pool.query("SELECT * FROM update_cashflow_entry_atomic($1,$2,$3::jsonb)",
      [EMPRESA, entry, JSON.stringify({ amount: "77.00", notes: "revisto" })]);
    const { rows } = await pool.query(
      "SELECT amount::text a, notes FROM cash_flow_entries WHERE id=$1", [entry]);
    expect(rows[0]).toEqual({ a: "77.00", notes: "revisto" });

    const outro = await movimentoManual();
    const { rows: del } = await pool.query(
      "SELECT apagados FROM delete_cashflow_entry_atomic($1,$2)", [EMPRESA, outro]);
    expect(del[0].apagados).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A prova de que a prova serve
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("mutação: sem o lock partilhado, a corrida volta", () => {
  it("uma guarda que lê fora do lock deixa passar a escrita divergente", async () => {
    // Reproduz-se o padrão antigo — SELECT, decidir, UPDATE, sem lock — e
    // mostra-se que ele perde. Se algum dia esta expectativa deixar de bater,
    // é porque o cenário deixou de reproduzir o defeito, e o ensaio de cima
    // passou a não provar nada.
    const id = await pagamento("100.00");

    const a = await ligacao();
    try {
      // Leitura da guarda antiga: sem movimento ligado, portanto "pode".
      const { rows: guarda } = await a.c.query(
        `SELECT count(*)::int n FROM cash_flow_entries
          WHERE reference_type='fixed_variable_payment' AND reference_id=$1`, [id]);
      expect(guarda[0].n).toBe(0);

      // Entretanto, outra ligação marca como pago.
      await pool.query("SELECT * FROM mark_payment_paid($1,$2,$3)", [EMPRESA, id, "2026-08-15"]);

      // A escrita antiga não revalida nada.
      await a.c.query("UPDATE fixed_variable_payments SET amount=$2 WHERE id=$1", [id, "999.00"]);

      const { rows } = await pool.query(
        `SELECT p.amount::text AS pago, c.amount::text AS mov
           FROM fixed_variable_payments p
           JOIN cash_flow_entries c ON c.reference_id = p.id
          WHERE p.id=$1`, [id]);
      // 🔴 Divergiu. É exactamente isto que a 082 impede.
      expect(rows[0].pago).not.toBe(rows[0].mov);
    } finally {
      a.c.release();
    }
  }, 60_000);
});
