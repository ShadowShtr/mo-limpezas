// T15 — Selecção de períodos do dashboard.
//
// O defeito coberto: `financial-dashboard.ts` decide "este mês" com
// `new Date()` num processo que corre em UTC na Vercel. Na primeira hora do dia
// 1 em hora de verão, o dashboard mostra os KPIs do mês anterior — enquanto
// `getOperationalSummary`, no mesmo ficheiro, já usa `todayInLisbon()` e mostra
// o mês certo. As duas metades da página discordam.

import { describe, it, expect } from "vitest";
import {
  buildDashboardPeriods,
  completedMonthsInYear,
  elapsedDaysInMonth,
  elapsedDaysInYear,
  monthKeyOf,
  totalDaysInMonth,
  totalDaysInYear,
} from "@/domain/dashboard/period-selection";
import { periodDays, periodKey } from "@/domain/reports/period";

describe("buildDashboardPeriods", () => {
  const p = buildDashboardPeriods("2026-08-13")!; // quinta-feira

  it("hoje é um período de um dia", () => {
    expect(p.today).toEqual({ start: "2026-08-13", end: "2026-08-13" });
    expect(periodDays(p.today)).toBe(1);
  });

  it("a semana vai de segunda a domingo", () => {
    expect(p.week).toEqual({ start: "2026-08-10", end: "2026-08-16" });
    expect(periodDays(p.week)).toBe(7);
  });

  it("o mês é o mês civil completo", () => {
    expect(p.month).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("o ano é o ano civil completo", () => {
    expect(p.year).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("o mês anterior é julho", () => {
    expect(periodKey(p.previousMonth)).toBe("2026-07");
  });

  it("os 12 meses terminam no mês corrente", () => {
    expect(p.last12Months).toHaveLength(12);
    expect(periodKey(p.last12Months[0])).toBe("2025-09");
    expect(periodKey(p.last12Months[11])).toBe("2026-08");
  });
});

describe("fronteiras de semana", () => {
  it("um domingo pertence à semana que começou na segunda anterior", () => {
    const p = buildDashboardPeriods("2026-08-16")!; // domingo
    expect(p.week).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("uma segunda-feira começa a própria semana", () => {
    const p = buildDashboardPeriods("2026-08-10")!;
    expect(p.week.start).toBe("2026-08-10");
  });

  it("a semana pode atravessar a fronteira do mês", () => {
    // O caso que fazia o denominador da avença encolher no dashboard.
    const p = buildDashboardPeriods("2026-08-01")!; // sábado
    expect(p.week).toEqual({ start: "2026-07-27", end: "2026-08-02" });
    expect(p.month.start).toBe("2026-08-01");
  });

  it("a semana pode atravessar a fronteira do ano", () => {
    const p = buildDashboardPeriods("2027-01-01")!; // sexta-feira
    expect(p.week).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

describe("fronteiras de mês e ano", () => {
  it("em janeiro o mês anterior é dezembro do ano passado", () => {
    const p = buildDashboardPeriods("2026-01-05")!;
    expect(periodKey(p.previousMonth)).toBe("2025-12");
  });

  it("fevereiro de ano comum e bissexto", () => {
    expect(periodDays(buildDashboardPeriods("2026-02-15")!.month)).toBe(28);
    expect(periodDays(buildDashboardPeriods("2028-02-15")!.month)).toBe(29);
  });

  it("o mês da mudança de hora não é especial", () => {
    // A aritmética é civil (Date.UTC), por isso o fim da hora de verão em
    // Portugal (último domingo de outubro) não altera contagens de dias.
    const p = buildDashboardPeriods("2026-10-25")!;
    expect(periodDays(p.month)).toBe(31);
    expect(periodDays(p.week)).toBe(7);
  });

  it("o primeiro dia do ano dá o ano inteiro", () => {
    const p = buildDashboardPeriods("2026-01-01")!;
    expect(periodDays(p.year)).toBe(365);
    expect(periodDays(buildDashboardPeriods("2028-01-01")!.year)).toBe(366);
  });
});

describe("entradas inválidas", () => {
  it("recusa em vez de assumir hoje", () => {
    expect(buildDashboardPeriods("lixo")).toBeNull();
    expect(buildDashboardPeriods("2026-02-30")).toBeNull();
    expect(buildDashboardPeriods("72026-01-01")).toBeNull();
  });
});

describe("contagens para a projeção", () => {
  it("dias decorridos no mês incluem hoje", () => {
    expect(elapsedDaysInMonth("2026-08-13")).toBe(13);
    expect(elapsedDaysInMonth("2026-08-01")).toBe(1);
    expect(totalDaysInMonth("2026-08-13")).toBe(31);
    expect(totalDaysInMonth("2026-02-13")).toBe(28);
  });

  it("dias decorridos no ano incluem hoje", () => {
    expect(elapsedDaysInYear("2026-01-01")).toBe(1);
    expect(elapsedDaysInYear("2026-02-01")).toBe(32);
    expect(elapsedDaysInYear("2026-12-31")).toBe(365);
    expect(elapsedDaysInYear("2028-12-31")).toBe(366);
  });

  it("dias totais do ano distinguem bissexto", () => {
    expect(totalDaysInYear("2026-06-01")).toBe(365);
    expect(totalDaysInYear("2028-06-01")).toBe(366);
  });

  it("meses completos NÃO incluem o mês corrente", () => {
    // A distinção que a projeção actual não faz: o mês corrente está a meio.
    expect(completedMonthsInYear("2026-01-15")).toBe(0);
    expect(completedMonthsInYear("2026-03-15")).toBe(2);
    expect(completedMonthsInYear("2026-12-31")).toBe(11);
  });
});

describe("monthKeyOf", () => {
  it("dá a chave YYYY-MM", () => {
    expect(monthKeyOf({ start: "2026-08-01", end: "2026-08-31" })).toBe("2026-08");
  });
});
