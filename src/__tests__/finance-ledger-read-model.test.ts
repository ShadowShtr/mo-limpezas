import { describe, expect, it } from "vitest";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";
import {
  loadFinanceLedger,
  type FinanceLedgerSource,
} from "@/lib/finance-ledger-query";

const payment = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "payment-1",
  kind: "variavel",
  description: "Combustível",
  amount: 150,
  due_date: "2026-08-20",
  status: "pendente",
  period_year: 2026,
  period_month: 8,
  paid_at: null,
  expense_category_id: "category-payment",
  category_name: "Viaturas",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
  ...patch,
});

const cashflow = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "cashflow-1",
  type: "saida",
  amount: 150,
  description: "Combustível",
  category: "despesa",
  date: "2026-08-21",
  reference_type: null,
  reference_id: null,
  status: "confirmado",
  expense_category_id: "category-cash",
  category_name: "Materiais",
  created_at: "2026-08-21T10:00:00Z",
  ...patch,
});

describe("finance unified read model", () => {
  it("UNI01: payment sem cashflow é uma obrigação", () => {
    const rows = buildFinanceLedger({ payments: [payment()], cashflows: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row_id: "payment:payment-1", cashflow_id: null, is_linked: false });
  });

  it("UNI02/UNI12: payment e cashflow persistidamente ligados aparecem uma vez", () => {
    const linked = cashflow({
      reference_type: "fixed_variable_payment",
      reference_id: "payment-1",
      expense_category_id: "wrong-snapshot",
      category_name: "Categoria antiga",
    });
    const rows = buildFinanceLedger({ payments: [payment({ status: "pago" })], cashflows: [linked] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_id: "payment:payment-1",
      cashflow_id: "cashflow-1",
      amount_cents: 15_000,
      expense_category_id: "category-payment",
      category_name: "Viaturas",
      date: "2026-08-21",
      is_linked: true,
    });
  });

  it("UNI03/UNI04: movimentos manuais de saída e entrada permanecem representáveis", () => {
    const rows = buildFinanceLedger({
      payments: [],
      cashflows: [cashflow(), cashflow({ id: "cashflow-in", type: "entrada" })],
    });
    expect(rows.map((row) => [row.row_id, row.direction, row.is_manual])).toEqual([
      ["cashflow:cashflow-1", "saida", true],
      ["cashflow:cashflow-in", "entrada", true],
    ]);
  });

  it("UNI05: retry/legado ligado nunca soma payment e cashflow", () => {
    const linked = cashflow({ reference_type: "fixed_variable_payment", reference_id: "payment-1" });
    const duplicate = cashflow({
      id: "cashflow-duplicate",
      reference_type: "fixed_variable_payment",
      reference_id: "payment-1",
      created_at: "2026-08-22T10:00:00Z",
    });
    const rows = buildFinanceLedger({ payments: [payment()], cashflows: [linked, duplicate] });
    expect(rows).toHaveLength(1);
    expect(rows.reduce((sum, row) => sum + (row.amount_cents ?? 0), 0)).toBe(15_000);
  });

  it("UNI08/UNI21: cashflows de outras origens conservam identidade própria", () => {
    const rows = buildFinanceLedger({
      payments: [],
      cashflows: [cashflow({ reference_type: "payroll", reference_id: "payroll-1" })],
    });
    expect(rows[0]).toMatchObject({ row_id: "cashflow:cashflow-1", origin: "payroll", is_manual: false });
  });

  it("não faz matching por descrição, valor ou data", () => {
    const rows = buildFinanceLedger({ payments: [payment()], cashflows: [cashflow()] });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.row_id).sort()).toEqual(["cashflow:cashflow-1", "payment:payment-1"]);
  });

  it("vínculo para pagamento ausente é visível como integridade degradada", () => {
    const rows = buildFinanceLedger({
      payments: [],
      cashflows: [cashflow({ reference_type: "fixed_variable_payment", reference_id: "missing" })],
    });
    expect(rows[0]).toMatchObject({
      row_id: "cashflow:cashflow-1",
      integrity_issue: "orphan_payment_reference",
    });
  });

  it("UNI27/UNI30: identidade e ordenação são estáveis em refetch", () => {
    const input = { payments: [payment()], cashflows: [cashflow({ id: "cashflow-2", date: "2026-08-25" })] };
    const first = buildFinanceLedger(input).map((row) => row.row_id);
    const second = buildFinanceLedger({ payments: [...input.payments], cashflows: [...input.cashflows] })
      .map((row) => row.row_id);
    expect(second).toEqual(first);
  });

  it("usa a data civil de Lisboa para o registo da obrigação", () => {
    const rows = buildFinanceLedger({
      payments: [payment({ created_at: "2026-08-01T23:30:00Z" })],
      cashflows: [],
    });
    expect(rows[0].date).toBe("2026-08-02");
  });
});

const ok = <T>(data: T) => ({ ok: true as const, data });

function source(overrides: Partial<FinanceLedgerSource> = {}): FinanceLedgerSource {
  return {
    paymentsByCompetence: async () => ok([payment()]),
    cashflowsByCashPeriod: async () => ok([]),
    paymentsByIds: async () => ok([]),
    cashflowsByPaymentIds: async () => ok([]),
    ...overrides,
  };
}

describe("finance ledger query orchestration", () => {
  it("resolve cashflow fora do mês para enriquecer a obrigação", async () => {
    const result = await loadFinanceLedger(source({
      cashflowsByPaymentIds: async () => ok([cashflow({
        date: "2026-09-02",
        reference_type: "fixed_variable_payment",
        reference_id: "payment-1",
      })]),
    }), { year: 2026, month: 8 });
    expect(result.ok && result.rows[0]).toMatchObject({ cash_date: "2026-09-02", is_linked: true });
  });

  it("resolve pagamento fora da competência para não duplicar a saída do mês", async () => {
    const linked = cashflow({ reference_type: "fixed_variable_payment", reference_id: "payment-outside" });
    const result = await loadFinanceLedger(source({
      paymentsByCompetence: async () => ok([]),
      cashflowsByCashPeriod: async () => ok([linked]),
      paymentsByIds: async () => ok([payment({ id: "payment-outside", period_month: 7 })]),
    }), { year: 2026, month: 8 });
    expect(result.ok && result.rows).toHaveLength(1);
    expect(result.ok && result.rows[0].row_id).toBe("payment:payment-outside");
  });

  it("UNI26: falha de consulta não se transforma em lista vazia", async () => {
    const result = await loadFinanceLedger(source({
      cashflowsByCashPeriod: async () => ({ ok: false, error: "database unavailable" }),
    }), { year: 2026, month: 8 });
    expect(result).toEqual({ ok: false, error: "database unavailable" });
    expect("rows" in result).toBe(false);
  });
});
