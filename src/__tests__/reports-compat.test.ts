// T14 — Comparador: relatórios antigos × read model canónico.
//
// Fixa o comportamento ANTIGO para que a mudança apareça como um número e não
// como uma surpresa no dia em que os ecrãs forem ligados ao modelo canónico.
//
// ⚠️ Fixtures sintéticas. Nenhum destes números é uma estimativa de impacto
//    real — medir isso exigiria ler produção, que a T14 não faz.

import { describe, it, expect } from "vitest";
import {
  compareCase,
  compareReportCases,
  defaultReportMatrix,
} from "@/domain/reports/reports-compat";
import {
  absenceUpperBound,
  legacyCountServices,
  legacyCsvVatFromTotal,
  legacyDailyTotals,
  legacyRevenueFromServices,
  legacyTotalAbsenceDays,
} from "@/domain/reports/legacy-reports";
import { monthPeriod, periodDays } from "@/domain/reports/period";
import type { AbsenceInput, ServiceInput } from "@/domain/reports/report-sources";
import { eurosToCents } from "@/domain/billing/money";

const AGOSTO = monthPeriod(2026, 8)!;
const cents = (v: number) => eurosToCents(v)!;

function svc(over: Partial<ServiceInput> = {}): ServiceInput {
  return {
    id: "s1", occurrenceDate: "2026-08-05", status: "concluido", contractId: null,
    valueCents: cents(100), applyVat: true, workedMinutes: null, scheduledMinutes: 60,
    ...over,
  };
}

describe("fórmulas antigas — fixadas tal como estão", () => {
  it("o absentismo antigo conta a duração inteira, não a interseção", () => {
    const baixa: AbsenceInput = {
      id: "a1", collaboratorId: "c1", type: "doenca_com_baixa",
      startsOn: "2026-08-01", endsOn: "2026-09-30",
    };
    expect(legacyTotalAbsenceDays([baixa])).toBe(61);
    expect(61).toBeGreaterThan(periodDays(AGOSTO));
  });

  it("o total antigo pode exceder o máximo possível para o período", () => {
    const baixa: AbsenceInput = {
      id: "a1", collaboratorId: "c1", type: "ferias",
      startsOn: "2026-01-01", endsOn: "2026-12-31",
    };
    expect(legacyTotalAbsenceDays([baixa])).toBeGreaterThan(absenceUpperBound(AGOSTO, 1));
  });

  it("a contagem antiga agrupa em_curso e sem_cobertura em agendado", () => {
    const counts = legacyCountServices([
      svc({ id: "1", status: "agendado" }),
      svc({ id: "2", status: "em_curso" }),
      svc({ id: "3", status: "sem_cobertura" }),
      svc({ id: "4", status: "estado_novo_qualquer" }),
    ]);
    expect(counts.agendado).toBe(4);
  });

  it("a receita antiga não vê a avença — o serviço vale 0 na base", () => {
    const avenca = [
      svc({ id: "a1", contractId: "c", valueCents: cents(0) }),
      svc({ id: "a2", contractId: "c", valueCents: cents(0) }),
    ];
    expect(legacyRevenueFromServices(avenca)).toBe(0);
  });

  it("o IVA do CSV antigo é aplicado sobre a soma, não linha a linha", () => {
    // 150 € somados, mas metade era isenta: o ficheiro leva IVA a mais.
    expect(legacyCsvVatFromTotal(150, 23)).toEqual({ iva: 34.5, total: 184.5 });
  });

  it("a série diária antiga só tem os dias com serviço", () => {
    const series = legacyDailyTotals(
      [svc({ occurrenceDate: "2026-08-05" }), svc({ id: "s2", occurrenceDate: "2026-08-06" })],
      new Map(), new Map(), 23,
    );
    expect(series.size).toBe(2);
    expect(series.size).toBeLessThan(periodDays(AGOSTO));
  });

  it("a avença antiga perde cêntimos: 100 € ÷ 3 nunca fecha", () => {
    const services = ["1", "2", "3"].map((id) =>
      svc({ id, contractId: "c", occurrenceDate: `2026-08-0${id}`, valueCents: cents(0) }),
    );
    const series = legacyDailyTotals(services, new Map([["c", 100]]), new Map([["c", false]]), 23);
    const soma = [...series.values()].reduce((a, d) => a + d.subtotal, 0);
    // Acumula em vírgula flutuante e arredonda por dia: 33.33 × 3 = 99.99.
    expect(soma).toBeCloseTo(99.99, 2);
    expect(soma).not.toBe(100);
  });
});

describe("compareCase", () => {
  it("assinala a avença invisível na receita", () => {
    const r = compareCase({
      label: "avença concluída", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: 300, applyVat: false,
      avencaStatuses: ["concluido", "concluido", "concluido"],
      adhoc: [], absences: [],
    });
    expect(r.reasons).toContain("MONTHLY_INVISIBLE_IN_REVENUE");
    expect(r.legacyRevenueCents).toBe(0);
    expect(r.canonicalPerformedCents).toBe(cents(300));
    expect(r.revenueDriftCents).toBe(cents(300));
  });

  it("assinala os cêntimos perdidos quando a divisão não é exacta", () => {
    const r = compareCase({
      label: "100 ÷ 3", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: 100, applyVat: false,
      avencaStatuses: ["concluido", "concluido", "concluido"],
      adhoc: [], absences: [],
    });
    expect(r.reasons).toContain("CENTS_LOST_IN_SPLIT");
  });

  it("não assinala cêntimos perdidos quando a divisão é exacta", () => {
    const r = compareCase({
      label: "300 ÷ 3", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: 300, applyVat: false,
      avencaStatuses: ["concluido", "concluido", "concluido"],
      adhoc: [], absences: [],
    });
    expect(r.reasons).not.toContain("CENTS_LOST_IN_SPLIT");
  });

  it("mede o excesso de absentismo em dias", () => {
    const r = compareCase({
      label: "ausência a atravessar", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: null, applyVat: false,
      avencaStatuses: [], adhoc: [],
      absences: [["2026-08-25", "2026-09-10"]],
    });
    expect(r.legacyAbsenceDays).toBe(17);
    expect(r.canonicalAbsenceDays).toBe(7);
    expect(r.absenceDriftDays).toBe(-10);
    expect(r.reasons).toContain("ABSENCE_OVERCOUNTED");
  });

  it("não acusa desvio quando a ausência cabe inteira no mês", () => {
    const r = compareCase({
      label: "ausência dentro", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: null, applyVat: false,
      avencaStatuses: [], adhoc: [],
      absences: [["2026-08-10", "2026-08-12"]],
    });
    expect(r.absenceDriftDays).toBe(0);
    expect(r.reasons).not.toContain("ABSENCE_OVERCOUNTED");
  });

  it("assinala os estados agrupados", () => {
    const r = compareCase({
      label: "estados", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: null, applyVat: false, avencaStatuses: [],
      adhoc: [["agendado", 10], ["em_curso", 10], ["sem_cobertura", 10]],
      absences: [],
    });
    expect(r.reasons).toContain("STATUS_BUCKETED");
    expect(r.legacyBucketedCount).toBe(3);
    expect(r.canonicalBucketedCount).toBe(3);
  });

  it("assinala os dias vazios em falta na série antiga", () => {
    const r = compareCase({
      label: "dias vazios", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: null, applyVat: false, avencaStatuses: [],
      adhoc: [["concluido", 10]], absences: [],
    });
    expect(r.reasons).toContain("EMPTY_DAYS_MISSING");
    expect(r.legacyDaysInSeries).toBe(1);
    expect(r.periodDayCount).toBe(31);
  });
});

describe("matriz determinística", () => {
  const matriz = defaultReportMatrix(23);

  it("cobre todas as classes de divergência conhecidas", () => {
    const { summary } = compareReportCases(matriz);
    expect(summary.byReason.CENTS_LOST_IN_SPLIT).toBeGreaterThan(0);
    expect(summary.byReason.MONTHLY_INVISIBLE_IN_REVENUE).toBeGreaterThan(0);
    expect(summary.byReason.ABSENCE_OVERCOUNTED).toBeGreaterThan(0);
    expect(summary.byReason.STATUS_BUCKETED).toBeGreaterThan(0);
    expect(summary.byReason.EMPTY_DAYS_MISSING).toBeGreaterThan(0);
    expect(summary.byReason.VAT_ON_AGGREGATE).toBeGreaterThan(0);
  });

  it("é determinística — duas execuções dão exactamente o mesmo relatório", () => {
    expect(JSON.stringify(compareReportCases(matriz)))
      .toBe(JSON.stringify(compareReportCases(defaultReportMatrix(23))));
  });

  it("encontra pelo menos um caso com absentismo impossível para o período", () => {
    const { summary } = compareReportCases(matriz);
    expect(summary.casesWithImpossibleAbsence).toBeGreaterThan(0);
  });

  it("inclui fevereiro comum, bissexto e o mês da mudança de hora", () => {
    const labels = matriz.map((c) => c.label);
    expect(labels).toContain("fevereiro de ano comum");
    expect(labels).toContain("fevereiro de ano bissexto");
    expect(labels).toContain("mês com fim da hora de verão");
  });

  it("inclui o mês vazio", () => {
    expect(matriz.map((c) => c.label)).toContain("mês vazio");
  });

  it("os casos contam-se por divergência, e o resumo fecha", () => {
    const r = compareReportCases(matriz);
    expect(r.summary.totalCases).toBe(matriz.length);
    expect(r.summary.changed + r.summary.unchanged).toBe(matriz.length);
    expect(r.cases.filter((c) => c.diverges)).toHaveLength(r.summary.changed);
  });

  it("o desvio de receita acumulado é o somatório dos casos", () => {
    const r = compareReportCases(matriz);
    const soma = r.cases.reduce((a, c) => a + c.revenueDriftCents, 0);
    expect(r.summary.totalRevenueDriftCents).toBe(soma);
  });
});

describe("o comparador não conhece o mundo real", () => {
  it("nenhum caso da matriz tem identificadores reais", () => {
    for (const c of defaultReportMatrix()) {
      expect(c.label).not.toMatch(/@|\+351|\d{9}/);
    }
  });

  it("um caso vazio não rebenta", () => {
    const r = compareCase({
      label: "vazio", year: 2026, month: 8, vatRatePct: 23,
      monthlyPriceEuros: null, applyVat: false,
      avencaStatuses: [], adhoc: [], absences: [],
    });
    expect(r.legacyRevenueCents).toBe(0);
    expect(r.canonicalPerformedCents).toBe(0);
  });
});
