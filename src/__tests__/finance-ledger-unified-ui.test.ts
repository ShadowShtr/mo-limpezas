import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
  type FinanceLedgerRow,
} from "@/domain/finance/ledger";
import {
  categorySlices,
  filterFinanceLedger,
  financeLedgerMetrics,
  originLabelFor,
  paginateFinanceLedger,
  presentationStatus,
} from "@/domain/finance/ledger-presentation";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const payment = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "p1", kind: "variavel", description: "Material", amount: 150,
  due_date: "2026-08-20", status: "pendente", period_year: 2026, period_month: 8,
  paid_at: null, direct_debit: false, notes: null, expense_category_id: "cat-a",
  category_name: "Materiais", created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z", ...patch,
});

const cashflow = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "c1", type: "saida", amount: 150, description: "Material", category: "despesa",
  date: "2026-08-21", reference_type: null, reference_id: null, status: "confirmado",
  expense_category_id: "cat-b", category_name: "Operação",
  created_at: "2026-08-21T10:00:00Z", notes: null, ...patch,
});

const linked = (p: FinanceLedgerPaymentSource = payment(), c: FinanceLedgerCashflowSource = cashflow()): FinanceLedgerRow =>
  buildFinanceLedger({ payments: [p], cashflows: [{ ...c, reference_type: "fixed_variable_payment", reference_id: p.id }] })[0];

describe("UNI15–UNI30 — métricas e apresentação unificadas", () => {
  it("UNI15: gráfico Competência usa obligations elegíveis", () => {
    const rows = buildFinanceLedger({ payments: [payment()], cashflows: [] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "competencia")).toEqual([
      { category_id: "cat-a", name: "Materiais", amount_cents: 15_000 },
    ]);
  });

  it("UNI16: gráfico Caixa usa cash outputs pela data de caixa", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow()] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")[0].amount_cents).toBe(15_000);
    expect(categorySlices(rows, { year: 2026, month: 7 }, "caixa")).toEqual([]);
  });

  it("UNI17: €150 payment + €150 linked não vira €300", () => {
    const row = linked(payment({ status: "pago" }));
    expect(categorySlices([row], { year: 2026, month: 8 }, "competencia")[0].amount_cents).toBe(15_000);
    expect(categorySlices([row], { year: 2026, month: 8 }, "caixa")[0].amount_cents).toBe(15_000);
  });

  it("UNI18: categoria atual do payment governa competência e caixa ligado", () => {
    const row = linked(
      payment({ expense_category_id: "new", category_name: "Nova" }),
      cashflow({ expense_category_id: "old", category_name: "Antiga" }),
    );
    expect(categorySlices([row], { year: 2026, month: 8 }, "competencia")[0].name).toBe("Nova");
    expect(categorySlices([row], { year: 2026, month: 8 }, "caixa")[0].name).toBe("Nova");
  });

  it("UNI19: ausência de categoria é explícita", () => {
    const rows = buildFinanceLedger({ payments: [payment({ expense_category_id: null, category_name: null })], cashflows: [] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "competencia")[0].name).toBe("Sem categoria");
  });

  it("cash pendente não é dinheiro já saído", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ status: "pendente" })] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")).toEqual([]);
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-30").cash_output_cents).toBe(0);
  });

  it("UNI22: entrada manual permanece na tabela, mas não entra em gastos", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ type: "entrada" })] });
    expect(rows).toHaveLength(1);
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")).toEqual([]);
  });

  it("UNI23: por pagar preserva o valor das obrigações", () => {
    const rows = buildFinanceLedger({ payments: [payment({ amount: 123.45 })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-10").due_cents).toBe(12_345);
  });

  it("pago mede competência sem depender do cashflow", () => {
    const rows = buildFinanceLedger({ payments: [payment({ status: "pago" })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-30").paid_cents).toBe(15_000);
  });

  it("due_date nula nunca inventa atraso", () => {
    const rows = buildFinanceLedger({ payments: [payment({ due_date: null })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2099-01-01").overdue_cents).toBe(0);
    expect(presentationStatus(rows[0], "2099-01-01")).toBe("Pendente");
  });

  it("filtros separam obrigação aberta, paga e manual", () => {
    const rows = buildFinanceLedger({
      payments: [payment(), payment({ id: "p2", status: "pago" })],
      cashflows: [cashflow()],
    });
    expect(filterFinanceLedger(rows, "por_pagar").map((row) => row.row_id)).toEqual(["payment:p1"]);
    expect(filterFinanceLedger(rows, "pagos").map((row) => row.row_id)).toEqual(["payment:p2"]);
    expect(filterFinanceLedger(rows, "manuais").map((row) => row.row_id)).toEqual(["cashflow:c1"]);
  });

  it("origens técnicas têm rótulos humanos", () => {
    expect(originLabelFor("fixed_variable_payment")).toBe("Pagamento");
    expect(originLabelFor("payroll")).toBe("Folha");
    expect(originLabelFor("invoice")).toBe("Cobrança");
  });

  it("estado em atraso exige obrigação aberta e vencimento real", () => {
    expect(presentationStatus(buildFinanceLedger({ payments: [payment()], cashflows: [] })[0], "2026-08-21")).toBe("Em atraso");
    expect(presentationStatus(linked(payment({ status: "pago" })), "2026-08-21")).toBe("Pago");
  });

  it("UNI27: página 1 mantém a ordenação canónica", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ id: "c1", date: "2026-08-01" }), cashflow({ id: "c2", date: "2026-08-02" })] });
    expect(paginateFinanceLedger(rows, 1, 1)[0].row_id).toBe("cashflow:c2");
  });

  it("paginação não repete uma row entre páginas", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ id: "c1" }), cashflow({ id: "c2" })] });
    expect(paginateFinanceLedger(rows, 1, 1)[0].row_id).not.toBe(paginateFinanceLedger(rows, 2, 1)[0].row_id);
  });

  it("UNI28/UNI29: pagamento pago ou ligado falha antes de delete", () => {
    const source = read("src/app/actions/payments.ts");
    const body = source.slice(source.indexOf("export async function deletePayment"), source.indexOf("// ─── Anexo"));
    expect(body).toContain("cash_flow_entries");
    expect(body).toMatch(/status === "pago" \|\| cashflowResult\.data/);
    expect(body.indexOf("status === \"pago\"")).toBeLessThan(body.indexOf(".delete()"));
  });

  it("movimento reconciliado falha fechado antes de update/delete", () => {
    const source = read("src/app/actions/cash-flow.ts");
    expect(source.match(/bank_reconciliation_matches/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("Não foi possível confirmar a conciliação. Nada foi alterado.");
    expect(source).toContain("Não foi possível confirmar a conciliação. Nada foi apagado.");
  });

  it("a página expõe colunas e tipos de criação definidos pelo produto", () => {
    const source = read("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx");
    for (const label of ["Data", "Descrição", "Vencimento", "Categoria", "Origem", "Valor", "Estado", "Ações"]) {
      expect(source).toContain(`"${label}"`);
    }
    for (const type of ["Conta a pagar", "Saída manual", "Entrada manual"]) expect(source).toContain(type);
    expect(source).not.toContain("Categoria de despesa");
  });
});
