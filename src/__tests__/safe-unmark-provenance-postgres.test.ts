/**
 * F14-B — desmarcar um pagamento não pode apagar histórico financeiro.
 *
 * B01–B12 do plano. Postgres 16 real, em contentor descartável: os pontos que
 * interessam aqui — cascade de conciliação, duas ligações a desmarcar ao mesmo
 * tempo, `FOR UPDATE` — não se reproduzem com um duplo em memória.
 *
 * As migrations em ensaio vivem em `supabase/migrations/draft/` e não têm
 * número: MIGRATION_NUMBER_FINAL = UNASSIGNED enquanto a 077/078/079 não
 * estiverem reconciliadas.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `f14b-safe-unmark-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const OLD_CATEGORY = "44444444-4444-4444-8444-444444444444";

let port = 0;
let pool: pg.Pool;

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}

function readSql(...parts: string[]) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}

/**
 * O esqueleto mínimo. `profiles` existe porque as políticas RLS da migration a
 * referem; `bank_reconciliation_matches` traz o `ON DELETE CASCADE` real da
 * 043 — sem ele, o teste da conciliação não estaria a testar nada.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
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
    match_score integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    created_at timestamptz NOT NULL DEFAULT now());
  -- auth.uid() não existe fora do Supabase; as políticas só precisam que
  -- resolva. O schema auth sobrevive ao DROP SCHEMA public, portanto é
  -- largado explicitamente — senão o segundo reset falha a recriar a função.
  DROP SCHEMA IF EXISTS auth CASCADE;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $auth$ SELECT NULL::uuid $auth$;

  -- 🔴 O resolver canónico de identidade. As políticas da 080 chamam-no, e
  --    chamam-no de propósito: desde a separação entre pessoa e conta de
  --    acesso, "profiles.id" deixou de ser o id da conta. Sem esta função a
  --    própria migração falha a criar as políticas — o que é o comportamento
  --    certo, e é isto que o garante aqui.
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $gmc$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $gmc$;

  -- O ledger do runner. A 081 exige lá a linha da 080 antes de correr.
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text,
    applied_at timestamptz NOT NULL DEFAULT now());
`;

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
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

/**
 * Aplica a 080 **e** regista-a no ledger, que é o que o runner faz. A 081
 * exige as duas coisas: a linha prova que correu pelo caminho oficial, a
 * tabela prova que o efeito lá está.
 */
async function aplicar080() {
  await pool.query(readSql("supabase", "migrations", "080_payment_cashflow_provenance.sql"));
  await pool.query(
    `INSERT INTO public._migrations(name, checksum)
     VALUES ('080_payment_cashflow_provenance.sql', 'ensaio')
     ON CONFLICT (name) DO NOTHING`);
}

async function reset() {
  await pool.query(BASELINE);
  await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
  await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
  await aplicar080();
  await pool.query(readSql("supabase", "migrations", "081_safe_unmark_payment_paid.sql"));
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Empresa de ensaio')", [COMPANY]);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Outra empresa')", [OTHER_COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Fornecedores','violeta')",
    [CATEGORY, COMPANY]);
  await pool.query(
    "INSERT INTO expense_categories(id,company_id,name,color) VALUES($1,$2,'Legado','cinza')",
    [OLD_CATEGORY, COMPANY]);
}

async function payment(over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO fixed_variable_payments
       (id,company_id,kind,description,amount,status,recurring,period_year,period_month,expense_category_id)
     VALUES($1,$2,'variavel',$3,$4,'pendente',false,2026,7,$5)`,
    [id, over.company_id ?? COMPANY, over.description ?? "Pagamento a fornecedor",
      over.amount ?? 100, over.expense_category_id ?? null],
  );
  return id;
}

/** Um movimento legado, como o que a reparação das 6 adopta. */
async function legacyCash(paymentId: string, over: Record<string, unknown> = {}) {
  const id = String(over.id ?? randomUUID());
  await pool.query(
    `INSERT INTO cash_flow_entries
       (id,company_id,type,amount,description,category,date,reference_type,reference_id,
        status,expense_category_id,notes)
     VALUES($1,$2,'saida',$3,$4,'despesa',$5,'fixed_variable_payment',$6,'pendente',$7,$8)`,
    [id, over.company_id ?? COMPANY, over.amount ?? 100,
      over.description ?? "Movimento legado", over.date ?? "2026-07-10", paymentId,
      over.expense_category_id ?? OLD_CATEGORY, over.notes ?? "nota legada"],
  );
  return id;
}

const mark = (id: string, paidOn = "2026-08-26") =>
  pool.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, id, paidOn]);
const unmark = (id: string) =>
  pool.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]);

async function cashFor(paymentId: string) {
  return (await pool.query(
    `SELECT id::text, status, date::text, amount::text, type,
            expense_category_id::text, notes, created_at
       FROM cash_flow_entries
      WHERE reference_type='fixed_variable_payment' AND reference_id=$1`,
    [paymentId])).rows;
}

const paymentStatus = async (id: string) =>
  (await pool.query("SELECT status FROM fixed_variable_payments WHERE id=$1", [id])).rows[0].status;

const provenance = async (cashId: string) =>
  (await pool.query(
    `SELECT origin, prestate_date::text, prestate_expense_category_id::text
       FROM payment_cashflow_provenance WHERE cash_flow_entry_id=$1`, [cashId])).rows;

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=f14b",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapping}`);
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "f14b", max: 12 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("F14-B — pagamento normal, sem movimento legado", () => {
  it("B01. marcar cria o movimento e regista que foi ele que o criou", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].status).toBe("confirmado");
    expect(await provenance(cash[0].id)).toEqual([
      { origin: "created_by_mark", prestate_date: null, prestate_expense_category_id: null },
    ]);
  });

  it("B02. repetir a marcação não cria um segundo movimento", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const primeiro = (await cashFor(id))[0].id;
    const segunda = await mark(id);
    expect(segunda.rows[0].ja_estava_pago).toBe(true);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(primeiro);
  });

  it("B03. desmarcar apaga o que a marcação criou — o comportamento canónico", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const resultado = await unmark(id);
    expect(resultado.rows[0].movimentos_removidos).toBe(1);
    expect(await cashFor(id)).toEqual([]);
    expect(await paymentStatus(id)).toBe("pendente");
  });
});

describe.sequential("F14-B — movimento legado adoptado", () => {
  it("B04. marcar adopta a linha que já lá estava, com o mesmo id", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect(cash[0].date).toBe("2026-08-26");
    expect(await provenance(legacy)).toEqual([
      { origin: "adopted_existing", prestate_date: "2026-07-10",
        prestate_expense_category_id: OLD_CATEGORY },
    ]);
  });

  it("B05. 🔴 desmarcar restaura a linha legada — não a apaga", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    const antes = (await cashFor(id))[0];
    await mark(id);
    const resultado = await unmark(id);

    expect(resultado.rows[0].movimentos_removidos).toBe(0);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
    expect(cash[0].date).toBe("2026-07-10");
    expect(cash[0].expense_category_id).toBe(OLD_CATEGORY);
    // O histórico do movimento legado sobrevive inteiro.
    expect(cash[0].notes).toBe(antes.notes);
    expect(cash[0].created_at).toEqual(antes.created_at);
    expect(await paymentStatus(id)).toBe("pendente");
  });

  it("B06. voltar a marcar reconfirma a mesma linha", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id);
    await mark(id);
    await unmark(id);
    await mark(id, "2026-09-01");
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect(cash[0].date).toBe("2026-09-01");
    // O prestate continua a ser o estado legado verdadeiro, não o do ciclo.
    expect((await provenance(legacy))[0].prestate_date).toBe("2026-07-10");
  });

  it("ciclo completo: mark → unmark → mark preserva o id e não duplica", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    for (let volta = 0; volta < 3; volta += 1) {
      await mark(id);
      expect((await cashFor(id))[0].status).toBe("confirmado");
      await unmark(id);
      expect((await cashFor(id))[0].status).toBe("pendente");
    }
    await mark(id);
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
  });
});

describe.sequential("F14-B — conciliação", () => {
  it("B07. 🔴 desmarcar um movimento conciliado falha fechado", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const tx = randomUUID();
    await pool.query(
      "INSERT INTO bank_transactions(id,company_id,status) VALUES($1,$2,'reconciled')",
      [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'confirmed')`, [COMPANY, tx, legacy]);

    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_RECONCILED_CASHFLOW/);

    // Nada se moveu: nem o movimento, nem a correspondência, nem o pagamento.
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("confirmado");
    expect((await pool.query(
      "SELECT count(*)::int n FROM bank_reconciliation_matches WHERE cash_flow_entry_id=$1",
      [legacy])).rows[0].n).toBe(1);
    expect(await paymentStatus(id)).toBe("pago");
  });

  it("B07b. o mesmo vale para um movimento que a marcação criou", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const cashId = (await cashFor(id))[0].id;
    const tx = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id) VALUES($1,$2)", [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'confirmed')`, [COMPANY, tx, cashId]);
    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_RECONCILED_CASHFLOW/);
    expect(await cashFor(id)).toHaveLength(1);
  });

  it("uma correspondência rejeitada não bloqueia — já não afirma nada", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const cashId = (await cashFor(id))[0].id;
    const tx = randomUUID();
    await pool.query("INSERT INTO bank_transactions(id,company_id) VALUES($1,$2)", [tx, COMPANY]);
    await pool.query(
      `INSERT INTO bank_reconciliation_matches(company_id,bank_transaction_id,cash_flow_entry_id,status)
       VALUES($1,$2,$3,'rejected')`, [COMPANY, tx, cashId]);
    await expect(unmark(id)).resolves.toBeDefined();
  });
});

describe.sequential("F14-B — concorrência e integridade", () => {
  it("B08. duas ligações a desmarcar ao mesmo tempo serializam-se", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    const b = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await a.connect();
    await b.connect();
    try {
      const resultados = await Promise.allSettled([
        a.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
        b.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
      ]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const cash = await cashFor(id);
      expect(cash).toHaveLength(1);
      expect(cash[0].id).toBe(legacy);
      expect(cash[0].status).toBe("pendente");
      expect(cash[0].date).toBe("2026-07-10");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("B09. marcar e desmarcar em simultâneo não deixa estado misto", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    const b = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await a.connect();
    await b.connect();
    try {
      await Promise.allSettled([
        a.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [COMPANY, id]),
        b.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, id, "2026-08-27"]),
      ]);
      const cash = await cashFor(id);
      const estado = await paymentStatus(id);
      expect(cash).toHaveLength(1);
      expect(cash[0].id).toBe(legacy);
      // Seja qual for a ordem em que terminaram, os dois lados concordam.
      expect(cash[0].status).toBe(estado === "pago" ? "confirmado" : "pendente");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("B10. um movimento sem relação com o pagamento não é tocado", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const alheio = randomUUID();
    await pool.query(
      `INSERT INTO cash_flow_entries(id,company_id,type,amount,description,category,date,status)
       VALUES($1,$2,'saida',50,'Movimento manual','despesa','2026-07-01','confirmado')`,
      [alheio, COMPANY]);
    await unmark(id);
    const intacto = (await pool.query(
      "SELECT status, amount::text FROM cash_flow_entries WHERE id=$1", [alheio])).rows[0];
    expect(intacto).toEqual({ status: "confirmado", amount: "50.00" });
  });

  it("B11. um erro a meio reverte tudo — proveniência incluída", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "f14b" });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)",
        [COMPANY, id, "2026-08-26"]);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
    const cash = await cashFor(id);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
    expect(cash[0].date).toBe("2026-07-10");
    expect(await provenance(legacy)).toEqual([]);
    expect(await paymentStatus(id)).toBe("pendente");
  });

  it("B12. proveniência de outra empresa não descreve um movimento desta", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    // Uma linha forjada não substitui a verdadeira: a chave primária é o
    // movimento, e já lá está a dizer que foi adoptado.
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'created_by_mark')`,
      [legacy, OTHER_COMPANY, id],
    )).rejects.toThrow();

    await unmark(id);
    // A verdade aguentou-se: restaurado, não apagado.
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].status).toBe("pendente");
  });

  it("um registo de adopção sem data de origem é impossível de escrever", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'adopted_existing')`,
      [legacy, COMPANY, id],
    )).rejects.toThrow(/payment_cashflow_provenance_adopted_needs_prestate/);
  });

  it("B18. um pagamento não pode ter duas proveniências", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    // Outro movimento, o mesmo pagamento: o índice único recusa.
    const outro = randomUUID();
    await pool.query(
      `INSERT INTO cash_flow_entries(id,company_id,type,amount,description,category,date,status)
       VALUES($1,$2,'saida',100,'Outro movimento','despesa','2026-07-11','pendente')`,
      [outro, COMPANY]);
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'created_by_mark')`,
      [outro, COMPANY, id],
    )).rejects.toThrow(/uq_payment_cashflow_provenance_payment/);
    expect((await provenance(legacy))[0].origin).toBe("adopted_existing");
  });

  it("um registo created_by_mark não pode trazer prestate", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin,prestate_date)
       VALUES($1,$2,$3,'created_by_mark','2026-07-10')`,
      [legacy, COMPANY, id],
    )).rejects.toThrow(/payment_cashflow_provenance_created_has_no_prestate/);
  });

  it("a proveniência não desaparece por alguém apagar o movimento", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    await mark(id);
    // 🔴 `ON DELETE RESTRICT`: um DELETE directo não leva o registo à frente.
    await expect(pool.query("DELETE FROM cash_flow_entries WHERE id=$1", [legacy]))
      .rejects.toThrow();
    expect(await provenance(legacy)).toHaveLength(1);
  });
});

describe.sequential("F14-B — proveniência desconhecida falha fechado", () => {
  it("B13. sem proveniência, desmarcar RECUSA — nunca apaga", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    const antes = (await cashFor(id))[0];
    await mark(id);
    // Um movimento anterior a esta infraestrutura: existe, mas ninguém sabe
    // de onde veio.
    await pool.query("DELETE FROM payment_cashflow_provenance WHERE cash_flow_entry_id=$1", [legacy]);

    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE/);

    // 🔴 O que interessa: a linha continua lá, e o pagamento continua pago.
    const cash = await cashFor(id);
    expect(cash).toHaveLength(1);
    expect(cash[0].id).toBe(legacy);
    expect(cash[0].notes).toBe(antes.notes);
    expect(cash[0].created_at).toEqual(antes.created_at);
    expect(await paymentStatus(id)).toBe("pago");
  });

  it("B14. confirmado sem proveniência: marcar é idempotente, desmarcar recusa", async () => {
    await reset();
    const id = await payment();
    const legacy = randomUUID();
    // Um movimento já confirmado e ligado, sem registo nenhum: daqui não se
    // distingue «criado pelo mark» de «adoptado e já confirmado».
    await pool.query(
      `INSERT INTO cash_flow_entries
         (id,company_id,type,amount,description,category,date,reference_type,reference_id,status)
       VALUES($1,$2,'saida',100,'Confirmado sem origem','despesa','2026-07-10',
              'fixed_variable_payment',$3,'confirmado')`,
      [legacy, COMPANY, id]);

    const resultado = await mark(id);
    expect(resultado.rows[0].ja_estava_pago).toBe(true);
    // 🔴 Marcar não fabrica uma proveniência que ninguém pode provar.
    expect(await provenance(legacy)).toEqual([]);

    await expect(unmark(id)).rejects.toThrow(/UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE/);
    expect(await cashFor(id)).toHaveLength(1);
  });

  it("B15. pendente sem proveniência: marcar captura a adopção antes de mutar", async () => {
    await reset();
    const id = await payment({ expense_category_id: CATEGORY });
    const legacy = await legacyCash(id, { date: "2026-06-15" });
    // Nenhum registo antes do mark — é o mark que tem de o criar.
    expect(await provenance(legacy)).toEqual([]);

    await mark(id);

    // 🔴 O prestate guardado é o de ANTES do UPDATE, não o de depois.
    expect(await provenance(legacy)).toEqual([
      { origin: "adopted_existing", prestate_date: "2026-06-15",
        prestate_expense_category_id: OLD_CATEGORY },
    ]);
    expect((await cashFor(id))[0].date).toBe("2026-08-26");
  });

  it("B16. adopted_existing nunca nasce de um movimento confirmado", async () => {
    await reset();
    const id = await payment();
    const legacy = randomUUID();
    await pool.query(
      `INSERT INTO cash_flow_entries
         (id,company_id,type,amount,description,category,date,reference_type,reference_id,status)
       VALUES($1,$2,'saida',100,'Confirmado','despesa','2026-07-10',
              'fixed_variable_payment',$3,'confirmado')`,
      [legacy, COMPANY, id]);
    await mark(id);
    // É este invariante que autoriza o unmark a derivar `status = pendente`
    // em vez de o guardar: adoptado ⇒ era pendente.
    expect(await provenance(legacy)).toEqual([]);
  });

  it("B17. proveniência de outra empresa é recusada pela chave estrangeira", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id);
    // O pagamento é desta empresa; declarar que a proveniência é de outra não
    // passa — e a chave primária já impede substituir a verdadeira.
    await mark(id);
    await expect(pool.query(
      `INSERT INTO payment_cashflow_provenance
         (cash_flow_entry_id,company_id,payment_id,origin)
       VALUES($1,$2,$3,'created_by_mark')`,
      [legacy, OTHER_COMPANY, id],
    )).rejects.toThrow();
    expect((await provenance(legacy))[0].origin).toBe("adopted_existing");
  });

  it("desmarcar um movimento criado pelo mark continua a apagá-lo", async () => {
    await reset();
    const id = await payment();
    await mark(id);
    const cashId = (await cashFor(id))[0].id;
    expect((await provenance(cashId))[0].origin).toBe("created_by_mark");
    const resultado = await unmark(id);
    expect(resultado.rows[0].movimentos_removidos).toBe(1);
    expect(await cashFor(id)).toEqual([]);
    // O registo de proveniência sai com ele — a FK RESTRICT obriga a que saia
    // primeiro, e é o unmark que o faz.
    expect(await provenance(cashId)).toEqual([]);
  });
});

describe.sequential("F14-B — dependência entre as duas peças", () => {
  const sql081 = () => readSql("supabase", "migrations", "081_safe_unmark_payment_paid.sql");

  async function baseAte079() {
    await pool.query(BASELINE);
    await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
    await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
  }

  it("B21. 🔴 a 081 recusa correr sem a 080 registada no ledger", async () => {
    await baseAte079();
    await expect(pool.query(sql081()))
      .rejects.toThrow(/REQUIRED_MIGRATION_080_NOT_APPLIED/);
  });

  it("B22. e recusa mesmo com a tabela lá, se o ledger não a conhece", async () => {
    // 🔴 A estrutura sozinha não chega: seria estrutura de origem não provada,
    //    que é exactamente o drift que esta frente teve de reconciliar antes.
    await baseAte079();
    await pool.query(readSql("supabase", "migrations", "080_payment_cashflow_provenance.sql"));
    await expect(pool.query(sql081()))
      .rejects.toThrow(/REQUIRED_MIGRATION_080_NOT_APPLIED/);
  });

  it("B23. e recusa com o ledger a mentir — linha sem tabela", async () => {
    await baseAte079();
    await pool.query(
      "INSERT INTO public._migrations(name, checksum) VALUES ('080_payment_cashflow_provenance.sql', 'mentira')");
    await expect(pool.query(sql081()))
      .rejects.toThrow(/REQUIRED_TABLE_PAYMENT_CASHFLOW_PROVENANCE_MISSING/);
  });

  it("B24. com a 080 aplicada e registada, a 081 corre", async () => {
    await baseAte079();
    await aplicar080();
    await expect(pool.query(sql081())).resolves.toBeDefined();
  });

  it("B25. a 080 sozinha não muda o comportamento observável", async () => {
    // A separação só é honesta se a peça 1 for mesmo inerte: a tabela fica lá,
    // vazia, e o mark/unmark continuam a ser os da 079 até a 081 correr.
    await baseAte079();
    const antes = (await pool.query(
      "SELECT pg_get_functiondef('public.mark_payment_paid'::regproc) d")).rows[0].d;
    await aplicar080();
    const depois = (await pool.query(
      "SELECT pg_get_functiondef('public.mark_payment_paid'::regproc) d")).rows[0].d;
    expect(depois).toEqual(antes);
    expect(depois).not.toContain("payment_cashflow_provenance");
  });
});

describe.sequential("F14-B — rollback das duas peças", () => {
  const down080 = () =>
    readSql("supabase", "migrations", "rollback", "080_payment_cashflow_provenance.down.sql");
  const down081 = () =>
    readSql("supabase", "migrations", "rollback", "081_safe_unmark_payment_paid.down.sql");

  // Sem os fins de linha: a 079 fica CRLF numa cópia de trabalho em Windows e o
  // ficheiro de rollback é LF. O corpo que o PostgreSQL guarda leva os CR
  // consigo, e comparar bytes estaria a medir o checkout, não o código. A
  // divergência a sério — texto diferente — é o que o B26 mede.
  const semCRLF = (t: string) => t.replace(/\r/g, "");
  const funcDef = async (nome: string) =>
    semCRLF((await pool.query("SELECT pg_get_functiondef($1::regproc) d", [nome])).rows[0].d);

  it("B19. sem linhas: o rollback da 081 repõe as duas funções, byte a byte", async () => {
    await pool.query(BASELINE);
    await pool.query(readSql("supabase", "migrations", "073_payment_to_cashflow.sql"));
    await pool.query(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
    const markAntes = await funcDef("public.mark_payment_paid");
    const unmarkAntes = await funcDef("public.unmark_payment_paid");

    await aplicar080();
    await pool.query(readSql("supabase", "migrations", "081_safe_unmark_payment_paid.sql"));
    expect(await funcDef("public.unmark_payment_paid")).not.toEqual(unmarkAntes);
    expect(await funcDef("public.mark_payment_paid")).not.toEqual(markAntes);

    await pool.query(down081());

    // 🔴 As **duas**, não só o unmark. O rollback fundido de que estas duas
    //    peças vieram repunha apenas `unmark_payment_paid` e esquecia o
    //    `mark_payment_paid`, que a 081 também substitui — deixaria um mark a
    //    inserir numa tabela prestes a ser largada. Foi a separação que
    //    tornou o esquecimento visível.
    expect(await funcDef("public.mark_payment_paid")).toEqual(markAntes);
    expect(await funcDef("public.unmark_payment_paid")).toEqual(unmarkAntes);

    // E não destruiu nada: a tabela é da 080 e continua lá.
    expect((await pool.query(
      "SELECT to_regclass('public.payment_cashflow_provenance') t")).rows[0].t).not.toBeNull();
  });

  it("B20. com proveniência adoptada: o rollback da 081 recusa, e não toca em nada", async () => {
    await reset();
    const id = await payment();
    const legacy = await legacyCash(id, { date: "2026-06-01" });
    await mark(id);
    const provAntes = await provenance(legacy);
    const unmarkAntes = await funcDef("public.unmark_payment_paid");

    await expect(pool.query(down081()))
      .rejects.toThrow(/ROLLBACK_BLOCKED_ADOPTED_PROVENANCE/);

    expect(await provenance(legacy)).toEqual(provAntes);
    expect(await funcDef("public.unmark_payment_paid")).toEqual(unmarkAntes);
    // E o unmark seguro continua a ser o que está instalado.
    await expect(unmark(id)).resolves.toBeDefined();
    expect((await cashFor(id))[0].date).toBe("2026-06-01");
  });

  it("B20b. mesmo só com registos created_by_mark, recusa — senão fica sem saída", async () => {
    // 🔴 Não há aqui histórico a perder, e ainda assim bloqueia. O motivo é a
    //    chave estrangeira RESTRICT: reposto o unmark antigo, que apaga o
    //    movimento sem limpar o registo, desmarcar passaria a rebentar — e a
    //    080 também já não poderia ser revertida, porque exige a tabela vazia.
    //    Deixaria o sistema num estado sem saída.
    await reset();
    const id = await payment();
    await mark(id);
    const [mov] = await cashFor(id);
    expect((await provenance(mov.id))[0].origin).toBe("created_by_mark");

    await expect(pool.query(down081()))
      .rejects.toThrow(/ROLLBACK_BLOCKED_PROVENANCE_ROWS_EXIST/);
  });

  it("B21r. 🔴 o rollback da 080 recusa enquanto a 081 estiver instalada", async () => {
    await reset();
    await expect(pool.query(down080()))
      .rejects.toThrow(/ROLLBACK_BLOCKED_081_STILL_INSTALLED/);
    expect((await pool.query(
      "SELECT to_regclass('public.payment_cashflow_provenance') t")).rows[0].t).not.toBeNull();
  });

  it("B22r. pela ordem certa e com a tabela vazia, a 080 larga tudo sem órfãos", async () => {
    await reset();
    await pool.query(down081());
    await pool.query(down080());

    expect((await pool.query(
      "SELECT to_regclass('public.payment_cashflow_provenance') t")).rows[0].t).toBeNull();
    expect((await pool.query(
      "SELECT count(*)::int n FROM pg_indexes WHERE indexname='uq_payment_cashflow_provenance_payment'")).rows[0].n).toBe(0);
    expect((await pool.query(
      "SELECT count(*)::int n FROM pg_policies WHERE tablename='payment_cashflow_provenance'")).rows[0].n).toBe(0);
  });

  it("B26. 🔴 a cópia do mark dentro do rollback não divergiu da 079", async () => {
    // O rollback tem de repor sozinho — reaplicar a 079 à mão a seguir seria
    // uma reversão em dois passos, e o segundo esquece-se. O preço de ser
    // auto-suficiente é uma cópia, e uma cópia diverge em silêncio. Este teste
    // é o que impede isso.
    //
    // Compara-se sem os fins de linha: a 079 fica CRLF numa cópia de trabalho
    // em Windows e o rollback é LF, e essa diferença não é divergência — é o
    // Git a normalizar. O que interessa é o texto.
    const semCRLF = (t: string) => t.replace(/\r/g, "");
    const s79 = semCRLF(readSql("supabase", "migrations", "079_reuse_pending_cashflow_on_payment.sql"));
    const down = semCRLF(readSql("supabase", "migrations", "rollback",
      "081_safe_unmark_payment_paid.down.sql"));

    const inicio = "CREATE OR REPLACE FUNCTION public.mark_payment_paid(";
    const bloco79 = s79.slice(s79.indexOf(inicio), s79.indexOf("\nCOMMIT;", s79.indexOf(inicio))).trimEnd();
    expect(bloco79.length).toBeGreaterThan(500);
    expect(down).toContain(bloco79);
  });
});
