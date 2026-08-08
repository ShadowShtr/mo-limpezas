// T15 — Comparador: dashboard antigo × read model canónico.
//
// Fixa o comportamento ANTIGO para que a mudança apareça como um número e não
// como uma surpresa no dia em que os cartões forem ligados ao modelo canónico.
//
// ⚠️ Fixtures sintéticas. Nenhum destes números é uma estimativa de impacto
//    real — medir isso exigiria ler produção, que a T15 não faz.

import { describe, it, expect } from "vitest";
import {
  compareDashboardCase,
  compareDashboardCases,
  defaultDashboardMatrix,
} from "@/domain/dashboard/dashboard-compat";
import {
  legacyClientRevenue,
  legacyMarginChartValue,
  legacyMarginPct,
  legacyMonthlyAggregation,
  legacyOperationalValue,
  legacyPendingRevenue,
  legacyProjectedAnnual,
  legacyTableMarginPct,
  type LegacyInvoiceRow,
} from "@/domain/dashboard/legacy-dashboard";
import { eurosToCents } from "@/domain/billing/money";

const cents = (v: number) => eurosToCents(v)!;

const EMPTY = {
  invoices: [] as readonly (readonly [number, string, string])[],
  payrollEuros: 0,
  expensesEuros: 0,
  receivedEuros: 0,
  services: [] as readonly (readonly [string, number, string])[],
  priorMonthsRevenueEuros: [] as readonly number[],
};
const BASE = { year: 2026, month: 3, vatRatePct: 23, ...EMPTY };

describe("fórmulas antigas — fixadas tal como estão", () => {
  const invoices: LegacyInvoiceRow[] = [
    { total: 1230, status: "pendente", periodStart: "2026-03-01", clientId: "c1" },
    { total: 5000, status: "rascunho", periodStart: "2026-03-01", clientId: "c2" },
    { total: 900, status: "cancelado", periodStart: "2026-03-01", clientId: "c3" },
  ];

  it("a receita mensal inclui rascunhos e exclui só as canceladas", () => {
    const [row] = legacyMonthlyAggregation(invoices, [], [{ year: 2026, month: 3 }]);
    expect(row.revenue).toBe(6230); // 1230 + 5000, o rascunho conta
  });

  it("os custos só contam a folha — as despesas não entram", () => {
    const [row] = legacyMonthlyAggregation(
      invoices,
      [{ periodYear: 2026, periodMonth: 3, netSalary: 500 }],
      [{ year: 2026, month: 3 }],
    );
    expect(row.costs).toBe(500);
    expect(row.margin).toBe(5730);
  });

  it("a percentagem de margem devolve 0% quando não há receita", () => {
    expect(legacyMarginPct(-3000, 0)).toBe(0);
    expect(legacyTableMarginPct(-3000, 0)).toBe(0);
  });

  it("as duas cópias da percentagem de margem concordam entre si", () => {
    for (const [m, r] of [[100, 500], [-50, 200], [0, 0], [-3000, 0]] as const) {
      expect(legacyMarginPct(m, r)).toBe(legacyTableMarginPct(m, r));
    }
  });

  it("o gráfico achata a margem negativa na linha de base", () => {
    // Um mês de prejuízo fica igual a um mês de margem zero.
    expect(legacyMarginChartValue(-500, 1000)).toBe(0);
    expect(legacyMarginChartValue(0, 1000)).toBe(0);
  });

  it("'pendente a receber' usa o texto do estado, não o vencimento", () => {
    expect(legacyPendingRevenue(invoices)).toBe(1230);
  });

  it("o gráfico por cliente esconde quem não tem fatura", () => {
    expect(legacyClientRevenue(invoices, 2026).map((c) => c.clientId)).toEqual(["c2", "c1"]);
  });

  it("os cartões de período usam uma grandeza diferente do KPI Receita", () => {
    // Parte de `services`, não de `invoices`, e divide a avença por um
    // denominador tirado da memória.
    const valor = legacyOperationalValue({
      fixedPrice: 300, isAvenca: true, countInMemory: 2,
      serviceValue: 0, applyVat: true, vatRatePct: 23,
    });
    expect(valor).toBeCloseTo(184.5, 2); // (300/2) × 1,23
  });

  it("a projeção usa numerador e denominador de conjuntos diferentes", () => {
    const monthly = [
      { year: 2026, month: 1, revenue: 1000, costs: 0, margin: 1000 },
      { year: 2026, month: 2, revenue: 1000, costs: 0, margin: 1000 },
      { year: 2026, month: 3, revenue: 200, costs: 0, margin: 200 },
    ];
    // 2200 ÷ 2 = 1100 de média, quando nenhum mês rendeu 1100.
    expect(legacyProjectedAnnual(monthly, 2026, 3)).toBe(12_100);
  });
});

describe("compareDashboardCase", () => {
  it("assinala o IVA dentro do KPI Receita", () => {
    const r = compareDashboardCase({
      ...BASE, label: "com IVA", invoices: [[1230, "pendente", "c1"]],
    });
    expect(r.reasons).toContain("REVENUE_INCLUDES_VAT");
  });

  it("assinala os rascunhos e mede o desvio", () => {
    const r = compareDashboardCase({
      ...BASE, label: "rascunho",
      invoices: [[1230, "pendente", "c1"], [5000, "rascunho", "c2"]],
    });
    expect(r.reasons).toContain("REVENUE_INCLUDES_DRAFTS");
    expect(r.legacyRevenueCents).toBe(cents(6230));
    expect(r.canonicalInvoicedCents).toBe(cents(1230));
    expect(r.revenueDriftCents).toBe(cents(-5000));
  });

  it("assinala as despesas fora dos custos e a margem inflacionada", () => {
    const r = compareDashboardCase({
      ...BASE, label: "despesas",
      invoices: [[1230, "pendente", "c1"]],
      payrollEuros: 500, expensesEuros: 300,
    });
    expect(r.reasons).toContain("COSTS_IGNORE_EXPENSES");
    expect(r.reasons).toContain("MARGIN_INFLATED");
    expect(r.legacyCostCents).toBe(cents(500));
    expect(r.canonicalCostCents).toBe(cents(800));
    expect(r.costDriftCents).toBe(cents(300));
    expect(r.marginDriftCents).toBe(cents(-300));
  });

  it("assinala o 0% mascarado quando há margem sem receita", () => {
    const r = compareDashboardCase({ ...BASE, label: "sem receita", payrollEuros: 3000 });
    expect(r.reasons).toContain("MARGIN_PCT_ZERO_MASK");
    expect(r.legacyMarginPct).toBe(0);
    expect(r.canonicalMarginPctKind).toBe("NOT_COMPARABLE");
  });

  it("assinala a margem negativa achatada", () => {
    const r = compareDashboardCase({
      ...BASE, label: "prejuízo",
      invoices: [[100, "pendente", "c1"]], payrollEuros: 3000,
    });
    expect(r.reasons).toContain("NEGATIVE_MARGIN_CLAMPED");
  });

  it("assinala o cliente escondido pelo gráfico antigo", () => {
    const r = compareDashboardCase({
      ...BASE, label: "cliente sem fatura",
      invoices: [[1230, "pendente", "c1"]],
      services: [["concluido", 200, "c2"]],
    });
    expect(r.reasons).toContain("CLIENT_WITHOUT_INVOICE_HIDDEN");
    expect(r.hiddenClients).toBe(1);
    expect(r.canonicalClientCount).toBeGreaterThan(r.legacyClientCount);
  });

  it("assinala a base desalinhada da projeção", () => {
    const r = compareDashboardCase({
      ...BASE, label: "projeção",
      invoices: [[200, "pendente", "c1"]],
      priorMonthsRevenueEuros: [1000, 1000],
    });
    expect(r.reasons).toContain("PROJECTION_MISMATCHED_BASIS");
    expect(r.projectionDriftCents).toBeLessThan(0); // a canónica é mais conservadora
  });

  it("um mês totalmente vazio não diverge", () => {
    const r = compareDashboardCase({ ...BASE, label: "vazio" });
    expect(r.diverges).toBe(false);
    expect(r.reasons).toEqual([]);
  });
});

describe("matriz determinística", () => {
  const matriz = defaultDashboardMatrix(23);

  it("cobre todas as classes de divergência conhecidas", () => {
    const { summary } = compareDashboardCases(matriz);
    for (const reason of Object.keys(summary.byReason) as (keyof typeof summary.byReason)[]) {
      expect(summary.byReason[reason], `razão sem cobertura: ${reason}`).toBeGreaterThan(0);
    }
  });

  it("é determinística — duas execuções dão o mesmo relatório", () => {
    expect(JSON.stringify(compareDashboardCases(matriz)))
      .toBe(JSON.stringify(compareDashboardCases(defaultDashboardMatrix(23))));
  });

  it("o resumo fecha com os casos", () => {
    const r = compareDashboardCases(matriz);
    expect(r.summary.totalCases).toBe(matriz.length);
    expect(r.summary.changed + r.summary.unchanged).toBe(matriz.length);
    expect(r.cases.filter((c) => c.diverges)).toHaveLength(r.summary.changed);
  });

  it("os desvios acumulados são a soma dos casos", () => {
    const r = compareDashboardCases(matriz);
    const soma = (f: (c: (typeof r.cases)[number]) => number) =>
      r.cases.reduce((a, c) => a + f(c), 0);
    expect(r.summary.totalRevenueDriftCents).toBe(soma((c) => c.revenueDriftCents));
    expect(r.summary.totalCostDriftCents).toBe(soma((c) => c.costDriftCents));
    expect(r.summary.totalMarginDriftCents).toBe(soma((c) => c.marginDriftCents));
    expect(r.summary.totalHiddenClients).toBe(soma((c) => c.hiddenClients));
  });

  it("inclui janeiro e dezembro, as fronteiras da projeção", () => {
    const labels = matriz.map((c) => c.label);
    expect(labels).toContain("janeiro — nenhum mês completo");
    expect(labels).toContain("dezembro — ano quase fechado");
  });

  it("nenhum caso tem identificadores reais", () => {
    for (const c of matriz) {
      expect(c.label).not.toMatch(/@|\+351|\d{9}/);
      for (const [, , clientId] of c.invoices) expect(clientId).toMatch(/^c\d+$/);
    }
  });
});
