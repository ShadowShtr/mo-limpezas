// ============================================================================
// T11 — Paridade entre consumidores + comparador legacy × canónico
// ============================================================================
// Prova, sobre fixtures sintéticas, que os quatro ecrãs partem da mesma vista e
// fecham no valor do contrato — e mede quanto dinheiro as fórmulas antigas
// perdem hoje.
//
// Nenhum teste aqui liga a Supabase, lê credenciais ou usa dados reais.

import { describe, it, expect } from "vitest";
import {
  assertConsumerParity,
  buildMonthlyBillingView,
  isEligible,
  selectDailyBilling,
  selectDashboardSummary,
  selectInvoicePreview,
  selectReportsByDay,
  type MonthlyOccurrenceInput,
} from "@/domain/billing/consumer-parity";
import {
  compareAvencaCase,
  compareAvencaCases,
  defaultAvencaMatrix,
  syntheticOccurrences,
} from "@/domain/billing/billing-compat";
import { eurosToCents, type MoneyCents } from "@/domain/billing/money";
import { sumMonthlyAllocations } from "@/domain/billing/monthly-allocation";

const c = (n: number) => n as MoneyCents;
const VAT = { applyVat: true, ratePct: 23 };

function month(statuses: MonthlyOccurrenceInput["status"][]): MonthlyOccurrenceInput[] {
  return statuses.map((status, i) => ({
    id: `occ-${String(i).padStart(3, "0")}`,
    occurrenceDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
    status,
  }));
}

describe("elegibilidade — decidida pelo caso de uso, não pelo helper", () => {
  const occ = (status: MonthlyOccurrenceInput["status"]) => month([status])[0];

  it("cancelado nunca entra", () => {
    expect(isEligible(occ("cancelado"), "SCHEDULED")).toBe(false);
    expect(isEligible(occ("cancelado"), "PERFORMED")).toBe(false);
  });

  it("agendado conta no agendado, não no realizado", () => {
    expect(isEligible(occ("agendado"), "SCHEDULED")).toBe(true);
    expect(isEligible(occ("agendado"), "PERFORMED")).toBe(false);
  });

  it("concluído conta nos dois", () => {
    expect(isEligible(occ("concluido"), "SCHEDULED")).toBe(true);
    expect(isEligible(occ("concluido"), "PERFORMED")).toBe(true);
  });

  it("falta continua a ocupar a agenda — comportamento actual, preservado", () => {
    expect(isEligible(occ("falta"), "SCHEDULED")).toBe(true);
    expect(isEligible(occ("falta"), "PERFORMED")).toBe(false);
  });
});

describe("a mesma vista serve os quatro ecrãs", () => {
  const view = buildMonthlyBillingView({
    contractId: "contrato-teste",
    monthlyTotalCents: eurosToCents(100),
    occurrences: month(["concluido", "concluido", "agendado", "cancelado"]),
    vat: VAT,
  });

  it("a Cobrança Diária mostra uma linha por ocorrência agendada", () => {
    const lines = selectDailyBilling(view, VAT);
    expect(lines).toHaveLength(3); // o cancelado saiu
    expect(lines.map((l) => l.netCents)).toEqual([3334, 3333, 3333]);
    expect(lines.reduce((s, l) => s + l.netCents, 0)).toBe(10000);
  });

  it("os Relatórios agrupam por dia sobre o realizado", () => {
    const byDay = selectReportsByDay(view, VAT);
    expect(byDay.size).toBe(2); // só os dois concluídos
    const total = [...byDay.values()].reduce((s, v) => s + v.netCents, 0);
    expect(total).toBe(10000); // fecha no valor do contrato
  });

  it("o Dashboard recebe o resumo canónico, sem calcular nada", () => {
    const s = selectDashboardSummary(view);
    expect(s.contracted.cents).toBe(10000);
    expect(s.scheduled.cents).toBe(10000);
    expect(s.performed.cents).toBe(10000);
    expect(s.received.completeness).toBe("UNAVAILABLE"); // T11 não carrega caixa
  });

  it("a Fatura emite uma linha única com o valor mensal inteiro", () => {
    const line = selectInvoicePreview(view);
    expect(line.netCents).toBe(10000);
    expect(line.vatCents).toBe(2300);
    expect(line.grossCents).toBe(12300);
  });

  it("os quatro concordam no total líquido do mês", () => {
    const parity = assertConsumerParity(view);
    expect(parity.agree).toBe(true);
    expect(parity.dailyNetCents).toBe(10000);
    expect(parity.reportsNetCents).toBe(10000);
    expect(parity.invoiceNetCents).toBe(10000);
  });

  it("concordam para qualquer combinação de contagem e valor", () => {
    for (const count of [1, 2, 3, 7, 11, 28, 31]) {
      for (const euros of [0.01, 1, 99.99, 100, 1000]) {
        const v = buildMonthlyBillingView({
          contractId: "x",
          monthlyTotalCents: eurosToCents(euros),
          occurrences: month(Array.from({ length: count }, () => "concluido" as const)),
          vat: VAT,
        });
        expect(assertConsumerParity(v).agree).toBe(true);
        expect(sumMonthlyAllocations(v.performedAllocation.allocations)).toBe(
          eurosToCents(euros),
        );
      }
    }
  });

  it("mês inteiro cancelado: nada alocado, valor contratado continua visível", () => {
    const v = buildMonthlyBillingView({
      contractId: "x",
      monthlyTotalCents: eurosToCents(300),
      occurrences: month(["cancelado", "cancelado"]),
      vat: VAT,
    });
    expect(v.scheduledAllocation.outcome).toBe("UNALLOCATED_NO_OCCURRENCES");
    expect(v.scheduledAllocation.unallocatedCents).toBe(30000);
    expect(selectDashboardSummary(v).contracted.cents).toBe(30000);
    expect(selectDashboardSummary(v).performed.cents).toBe(0);
  });

  it("contrato sem valor mensal não vira zero", () => {
    const v = buildMonthlyBillingView({
      contractId: "x",
      monthlyTotalCents: null,
      occurrences: month(["concluido"]),
      vat: VAT,
    });
    expect(v.scheduledAllocation.outcome).toBe("UNALLOCATED_NO_AMOUNT");
    expect(selectDashboardSummary(v).contracted.cents).toBeNull();
  });
});

describe("comparador legacy × canónico", () => {
  it("o caso do plano mestre: 100 € em 3 ocorrências", () => {
    const r = compareAvencaCase({
      label: "100€ ÷ 3",
      fixedPriceEuros: 100,
      occurrenceCount: 3,
      applyVat: false,
      vatRatePct: 23,
    });
    expect(r.canonicalAllocatedCents).toBe(10000);
    expect(r.legacyDailyTotalCents).toBe(9999); // o cêntimo perdido
    expect(r.dailyDriftCents).toBe(-1);
    expect(r.legacyReportsTotalCents).toBe(10000); // os Relatórios não o perdem
    expect(r.reasons).toContain("CENTS_LOST_IN_SPLIT");
    expect(r.reasons).toContain("CONSUMERS_DISAGREE");
  });

  it("a fatura nunca divide — por isso nunca perde, mas também nunca bate por dia", () => {
    const r = compareAvencaCase({
      label: "100€ ÷ 3",
      fixedPriceEuros: 100,
      occurrenceCount: 3,
      applyVat: false,
      vatRatePct: 23,
    });
    expect(r.legacyInvoiceTotalCents).toBe(10000);
    expect(r.invoiceDriftCents).toBe(0);
  });

  it("valor divisível não diverge em lado nenhum", () => {
    const r = compareAvencaCase({
      label: "90€ ÷ 3",
      fixedPriceEuros: 90,
      occurrenceCount: 3,
      applyVat: false,
      vatRatePct: 23,
    });
    expect(r.dailyDriftCents).toBe(0);
    expect(r.reasons).not.toContain("CENTS_LOST_IN_SPLIT");
  });

  it("sem ocorrências, o antigo divide por 1 e o canónico não aloca", () => {
    const r = compareAvencaCase({
      label: "300€ ÷ 0",
      fixedPriceEuros: 300,
      occurrenceCount: 0,
      applyVat: false,
      vatRatePct: 23,
    });
    expect(r.canonicalAllocatedCents).toBe(0);
    expect(r.legacyDailyTotalCents).toBe(30000); // inventa um mês inteiro numa linha
    expect(r.reasons).toContain("NO_OCCURRENCES_FALLBACK");
  });

  it("a matriz padrão é determinística e encontra divergências reais", () => {
    const a = compareAvencaCases(defaultAvencaMatrix(23));
    const b = compareAvencaCases(defaultAvencaMatrix(23));
    expect(b.summary).toEqual(a.summary);
    expect(a.summary.totalCases).toBe(7 * 9 * 2);
    expect(a.summary.changed).toBeGreaterThan(0);
    // A Cobrança Diária nunca ganha dinheiro face ao canónico: ou empata, ou
    // perde. Um desvio positivo seria um defeito novo, não o conhecido.
    const perdaMaxima = a.cases
      .filter((x) => x.occurrenceCount > 0)
      .reduce((worst, x) => Math.min(worst, x.dailyDriftCents), 0);
    expect(perdaMaxima).toBeLessThan(0);
  });

  it("as ocorrências sintéticas nunca colidem em id", () => {
    const occ = syntheticOccurrences(31);
    expect(new Set(occ.map((o) => o.id)).size).toBe(31);
  });

  it("o canónico fecha a soma em todos os casos da matriz", () => {
    for (const r of compareAvencaCases(defaultAvencaMatrix(23)).cases) {
      if (r.occurrenceCount === 0) continue;
      expect(r.canonicalAllocatedCents).toBe(r.totalCents ?? 0);
    }
  });
});

describe("invariantes gerais", () => {
  it("a ordem de chegada das ocorrências não muda o total", () => {
    const occ = month(Array.from({ length: 11 }, () => "concluido" as const));
    const direta = buildMonthlyBillingView({
      contractId: "x", monthlyTotalCents: c(99999), occurrences: occ, vat: VAT,
    });
    const invertida = buildMonthlyBillingView({
      contractId: "x", monthlyTotalCents: c(99999), occurrences: [...occ].reverse(), vat: VAT,
    });
    expect(invertida.performedVat).toEqual(direta.performedVat);
    expect(invertida.performedAllocation.allocations).toEqual(
      direta.performedAllocation.allocations,
    );
  });

  it("ocorrências duplicadas não duplicam dinheiro", () => {
    const dup = [...month(["concluido", "concluido"]), ...month(["concluido", "concluido"])];
    const v = buildMonthlyBillingView({
      contractId: "x", monthlyTotalCents: eurosToCents(100), occurrences: dup, vat: VAT,
    });
    expect(v.performedAllocation.duplicateCount).toBe(2);
    expect(v.performedAllocation.allocations).toHaveLength(2);
    expect(sumMonthlyAllocations(v.performedAllocation.allocations)).toBe(10000);
  });
});
