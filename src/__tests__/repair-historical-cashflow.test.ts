// ============================================================================
// REPAIR HISTÓRICO — a lista fechada e as barreiras que a protegem
// ============================================================================
// Entre a 049 e a 073 havia uma incompatibilidade de CHECK que fazia a
// marcação de pagamento ser revertida por inteiro. A 075 corrigiu-a, mas os
// pagamentos que ficaram `pago` antes disso não têm movimento de caixa.
//
// 🔴 O risco desta operação não é falhar — é ter sucesso a mais. Criar uma
//    saída de €550 onde alguém já lançou a renda à mão conta a mesma despesa
//    duas vezes, e ninguém nota até fechar o mês.
//
// A primeira versão do gate anti-duplicação usava uma janela de ±7 dias e
// devolveu **zero conflitos em 39 candidatos** — parecia excelente e estava
// cega: os lançamentos manuais reais estão a −13, −21, −33, −54 e −69 dias do
// `paid_at`. Com a janela corrigida, 18 pagamentos saíram da reparação
// automática. São €3.529,32 que teriam sido duplicados.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { LISTA_FECHADA, TOTAL_ESPERADO, somaCentimos } from "../../scripts/repair-fixed-variable-payment-cashflow.mjs";

const COMPANY = "11111111-1111-1111-1111-111111111111";

async function base() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.companies (id uuid PRIMARY KEY);
    CREATE TABLE public.financial_periods (
      company_id uuid NOT NULL, year smallint NOT NULL, month smallint NOT NULL,
      status text NOT NULL DEFAULT 'open',
      UNIQUE (company_id, year, month)
    );
    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      description text NOT NULL,
      amount numeric(10,2),
      status text NOT NULL DEFAULT 'pendente',
      paid_at timestamptz,
      expense_category_id uuid,
      period_year int, period_month int
    );
    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      type text NOT NULL,
      amount numeric(10,2) NOT NULL,
      description text NOT NULL,
      category text,
      date date NOT NULL,
      status text NOT NULL DEFAULT 'pendente',
      reference_type text,
      reference_id uuid,
      expense_category_id uuid
    );
    CREATE UNIQUE INDEX cash_flow_entries_reference_unique
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
  `);
  await db.query("INSERT INTO public.companies VALUES ($1)", [COMPANY]);
  return db;
}

async function pagamento(db: PGlite, over: Record<string, unknown> = {}) {
  const p = {
    description: "RENDA ATL", amount: "550.00", status: "pago",
    paid_at: "2026-07-22T10:00:00Z", period_year: 2026, period_month: 7,
    ...over,
  };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.fixed_variable_payments
       (company_id, description, amount, status, paid_at, period_year, period_month)
     VALUES ($1,$2,$3::numeric,$4,$5::timestamptz,$6,$7) RETURNING id`,
    [COMPANY, p.description, p.amount, p.status, p.paid_at, p.period_year, p.period_month],
  );
  return rows[0].id;
}

/** O que o script faz por linha, reduzido à decisão: reparar ou não. */
async function elegivel(db: PGlite, paymentId: string): Promise<{ ok: boolean; motivo?: string }> {
  const { rows } = await db.query<Record<string, string | null>>(
    `SELECT id, company_id, amount::text AS amount, status, paid_at,
            period_year, period_month,
            (paid_at AT TIME ZONE 'Europe/Lisbon')::date::text AS cashflow_date
       FROM public.fixed_variable_payments WHERE id = $1`, [paymentId]);
  if (rows.length === 0) return { ok: false, motivo: "inexistente" };
  const p = rows[0];

  if (p.status !== "pago") return { ok: false, motivo: "não está pago" };
  if (!p.paid_at) return { ok: false, motivo: "sem paid_at" };

  const { rows: ligado } = await db.query(
    `SELECT id FROM public.cash_flow_entries
      WHERE company_id=$1 AND reference_type='fixed_variable_payment' AND reference_id=$2`,
    [p.company_id, p.id]);
  if (ligado.length > 0) return { ok: false, motivo: "já ligado" };

  const { rows: manuais } = await db.query(
    `SELECT id FROM public.cash_flow_entries
      WHERE company_id=$1 AND type='saida' AND amount=$2::numeric AND reference_type IS NULL`,
    [p.company_id, p.amount]);
  if (manuais.length > 0) return { ok: false, motivo: "movimento manual do mesmo valor" };

  const { rows: fechado } = await db.query(
    `SELECT 1 FROM public.financial_periods
      WHERE company_id=$1 AND year=$2 AND month=$3 AND status='closed'`,
    [p.company_id, p.period_year, p.period_month]);
  if (fechado.length > 0) return { ok: false, motivo: "período fechado" };

  return { ok: true };
}

async function inserir(db: PGlite, paymentId: string) {
  const { rows } = await db.query<Record<string, string | null>>(
    `SELECT company_id, description, amount::text AS amount, expense_category_id,
            (paid_at AT TIME ZONE 'Europe/Lisbon')::date::text AS d
       FROM public.fixed_variable_payments WHERE id=$1`, [paymentId]);
  const p = rows[0];
  await db.query(
    `INSERT INTO public.cash_flow_entries
       (company_id,type,amount,description,category,date,reference_type,reference_id,status,expense_category_id)
     VALUES ($1,'saida',$2::numeric,$3,'despesa',$4::date,'fixed_variable_payment',$5,'confirmado',$6)`,
    [p.company_id, p.amount, p.description, p.d, paymentId, p.expense_category_id],
  );
}

async function contarOrigem(db: PGlite, paymentId: string) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.cash_flow_entries
      WHERE reference_type='fixed_variable_payment' AND reference_id=$1`, [paymentId]);
  return rows[0].n;
}

let db: PGlite;
beforeEach(async () => { db = await base(); });

describe("a lista fechada", () => {
  it("tem 21 pagamentos e soma exactamente 4477.36 €", () => {
    expect(LISTA_FECHADA).toHaveLength(21);
    // Cêntimos inteiros: somar floats de dinheiro acumula erro.
    expect(somaCentimos(LISTA_FECHADA)).toBe(Math.round(parseFloat(TOTAL_ESPERADO) * 100));
  });

  it("não tem ids repetidos", () => {
    const ids = LISTA_FECHADA.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("todas as linhas têm id, valor e data válidos", () => {
    for (const l of LISTA_FECHADA) {
      expect(l.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isNaN(parseFloat(l.valor))).toBe(false);
      expect(l.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(parseFloat(l.valor)).toBeGreaterThan(0);
    }
  });
});

describe("🔴 quem entra e quem não entra", () => {
  it("STRONG: cria exactamente um movimento", async () => {
    const id = await pagamento(db);
    expect((await elegivel(db, id)).ok).toBe(true);
    await inserir(db, id);
    expect(await contarOrigem(db, id)).toBe(1);
  });

  it("ALREADY_LINKED: não repara duas vezes", async () => {
    const id = await pagamento(db);
    await inserir(db, id);
    const r = await elegivel(db, id);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("já ligado");
  });

  it("🔴 MANUAL_TWIN exacto: não repara", async () => {
    const id = await pagamento(db);
    await db.query(
      `INSERT INTO public.cash_flow_entries (company_id,type,amount,description,date,status)
       VALUES ($1,'saida',550.00,'Renda ATL julho','2026-07-22','confirmado')`, [COMPANY]);
    const r = await elegivel(db, id);
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("manual");
  });

  it("🔴 MANUAL_TWIN a 54 dias: não repara — foi este o caso real", async () => {
    // A janela de ±7 dias da primeira versão deixava passar exactamente isto.
    const id = await pagamento(db, { amount: "9.13", description: "ENDESA GARAGEM 2" });
    await db.query(
      `INSERT INTO public.cash_flow_entries (company_id,type,amount,description,date,status)
       VALUES ($1,'saida',9.13,'endesa','2026-06-03','confirmado')`, [COMPANY]);
    const r = await elegivel(db, id);
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("manual");
  });

  it("valor diferente não é conflito", async () => {
    const id = await pagamento(db);
    await db.query(
      `INSERT INTO public.cash_flow_entries (company_id,type,amount,description,date,status)
       VALUES ($1,'saida',551.00,'outra coisa','2026-07-22','confirmado')`, [COMPANY]);
    expect((await elegivel(db, id)).ok).toBe(true);
  });

  it("movimento de outra empresa não é conflito", async () => {
    const outra = "22222222-2222-2222-2222-222222222222";
    await db.query("INSERT INTO public.companies VALUES ($1)", [outra]);
    const id = await pagamento(db);
    await db.query(
      `INSERT INTO public.cash_flow_entries (company_id,type,amount,description,date,status)
       VALUES ($1,'saida',550.00,'renda','2026-07-22','confirmado')`, [outra]);
    expect((await elegivel(db, id)).ok).toBe(true);
  });

  it("NO_PAID_AT: não repara — inventar a data seria inventar o facto", async () => {
    const id = await pagamento(db, { paid_at: null });
    const r = await elegivel(db, id);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("sem paid_at");
  });

  it("CLOSED_PERIOD: não repara", async () => {
    const id = await pagamento(db);
    await db.query(
      `INSERT INTO public.financial_periods (company_id,year,month,status)
       VALUES ($1,2026,7,'closed')`, [COMPANY]);
    const r = await elegivel(db, id);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("período fechado");
  });

  it("pagamento revertido a pendente: não repara", async () => {
    const id = await pagamento(db, { status: "pendente" });
    expect((await elegivel(db, id)).ok).toBe(false);
  });
});

describe("🔴 idempotência", () => {
  it("segunda execução não acrescenta nada", async () => {
    const id = await pagamento(db);
    await inserir(db, id);
    expect((await elegivel(db, id)).ok).toBe(false);
    expect(await contarOrigem(db, id)).toBe(1);
  });

  it("o índice de origem rejeita um segundo insert cru", async () => {
    const id = await pagamento(db);
    await inserir(db, id);
    await expect(inserir(db, id)).rejects.toThrow(/duplicate|unique/i);
    expect(await contarOrigem(db, id)).toBe(1);
  });
});

describe("🔴 a data é civil de Lisboa, não UTC truncado", () => {
  it("23:30 UTC de 21/07 no verão é dia 22 em Lisboa", async () => {
    // Lisboa está em UTC+1 no verão: truncar o UTC daria o dia anterior, e o
    // movimento cairia no mês errado quando isto acontece a 31.
    const id = await pagamento(db, { paid_at: "2026-07-21T23:30:00Z" });
    await inserir(db, id);
    const { rows } = await db.query<{ date: string }>(
      `SELECT date::text FROM public.cash_flow_entries WHERE reference_id=$1`, [id]);
    expect(rows[0].date).toBe("2026-07-22");
  });

  it("00:30 UTC de 15/01 no inverno continua dia 15", async () => {
    const id = await pagamento(db, { paid_at: "2026-01-15T00:30:00Z", period_month: 1 });
    await inserir(db, id);
    const { rows } = await db.query<{ date: string }>(
      `SELECT date::text FROM public.cash_flow_entries WHERE reference_id=$1`, [id]);
    expect(rows[0].date).toBe("2026-01-15");
  });
});

describe("o movimento criado tem a forma que a 073 declara", () => {
  it("saida · despesa · confirmado · origem correcta", async () => {
    const id = await pagamento(db);
    await inserir(db, id);
    const { rows } = await db.query<Record<string, string>>(
      `SELECT type, category, status, reference_type, reference_id, amount::text AS amount,
              description
         FROM public.cash_flow_entries WHERE reference_id=$1`, [id]);
    expect(rows[0]).toMatchObject({
      type: "saida", category: "despesa", status: "confirmado",
      reference_type: "fixed_variable_payment", reference_id: id,
      amount: "550.00", description: "RENDA ATL",
    });
  });

  it("🔴 o pagamento não é alterado — é história real", async () => {
    const id = await pagamento(db);
    const antes = await db.query(
      `SELECT status, paid_at, amount::text AS amount, description
         FROM public.fixed_variable_payments WHERE id=$1`, [id]);
    await inserir(db, id);
    const depois = await db.query(
      `SELECT status, paid_at, amount::text AS amount, description
         FROM public.fixed_variable_payments WHERE id=$1`, [id]);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });
});

describe("🔴 o script não descobre candidatos sozinho", () => {
  it("a lista está embutida no ficheiro, não vem de uma query", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/repair-fixed-variable-payment-cashflow.mjs", "utf8");
    // Um script que procura o que reparar no momento de escrever pode
    // encontrar coisas diferentes das que alguém aprovou.
    expect(src).toContain("LISTA_FECHADA");
    expect(src).not.toMatch(/SELECT[\s\S]{0,200}WHERE[\s\S]{0,80}status\s*=\s*'pago'[\s\S]{0,200}INSERT/i);
  });

  it("o modo por omissão é dry-run", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/repair-fixed-variable-payment-cashflow.mjs", "utf8");
    expect(src).toContain('process.argv.includes("--apply")');
    expect(src).toContain("DRY-RUN");
  });

  it("recusa executar se a lista não somar o total declarado", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/repair-fixed-variable-payment-cashflow.mjs", "utf8");
    // Alterar a lista sem actualizar o total é a forma mais provável de
    // alguém acrescentar uma linha sem a submeter a revisão.
    expect(src).toContain("A lista foi alterada sem actualizar o total");
  });

  it("é tudo ou nada — uma linha recusada aborta o lote", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/repair-fixed-variable-payment-cashflow.mjs", "utf8");
    expect(src).toMatch(/recusados\.length > 0[\s\S]{0,300}ROLLBACK/);
  });
});
