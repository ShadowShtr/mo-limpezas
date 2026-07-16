import { describe, it, expect } from "vitest";
import { getOccurrences, shiftToNextBusinessDay, type OccurrenceContract } from "@/lib/contract-occurrences";
import type { ScheduleDay } from "@/types/database";

const SCHEDULE: ScheduleDay[] = [
  { day: "all", start_time: "09:00", duration_min: 120, team_id: "team-1" },
];

function base(overrides: Partial<OccurrenceContract>): OccurrenceContract {
  return {
    frequency: "monthly",
    weekdays: null,
    interval_days: 1,
    schedule_days: SCHEDULE,
    starts_on: "2026-07-01",
    ends_on: null,
    excluded_dates: [],
    ...overrides,
  };
}

// ─── shiftToNextBusinessDay ───────────────────────────────────────────────────

describe("shiftToNextBusinessDay", () => {
  it("empurra sábado para segunda (+2 dias)", () => {
    const sat = new Date(2026, 6, 18); // 2026-07-18 é sábado
    expect(sat.getDay()).toBe(6);
    const shifted = shiftToNextBusinessDay(sat);
    expect(shifted.getDay()).toBe(1);
    expect(shifted.getDate()).toBe(20);
  });

  it("empurra domingo para segunda (+1 dia)", () => {
    const sun = new Date(2026, 6, 19); // 2026-07-19 é domingo
    expect(sun.getDay()).toBe(0);
    const shifted = shiftToNextBusinessDay(sun);
    expect(shifted.getDay()).toBe(1);
    expect(shifted.getDate()).toBe(20);
  });

  it("não mexe em dia útil", () => {
    const wed = new Date(2026, 6, 15); // quarta
    const shifted = shiftToNextBusinessDay(wed);
    expect(shifted.getTime()).toBe(wed.getTime());
  });
});

// ─── mensal ────────────────────────────────────────────────────────────────

describe("getOccurrences — mensal", () => {
  it("gera no dia do mês quando cai em dia útil", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-07-15" }); // 15/07/2026 = quarta
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ).toHaveLength(1);
    expect(occ[0].date.getDate()).toBe(15);
  });

  it("empurra para segunda quando o dia do mês cai em fim de semana (caso relatado: 17/10 sábado)", () => {
    // Contrato com dia de início 17 → em outubro de 2026 o dia 17 é sábado.
    const contract = base({ frequency: "monthly", starts_on: "2026-01-17" });
    const oct = getOccurrences(contract, new Date(2026, 9, 1), new Date(2026, 9, 31, 23, 59, 59));
    expect(oct).toHaveLength(1);
    expect(oct[0].date.getDay()).toBe(1); // segunda
    expect(oct[0].date.getDate()).toBe(19); // 17 (sáb) + 2 = 19
  });

  it("mantém a ocorrência mesmo quando o desvio ultrapassa o fim do mês gerado", () => {
    // dia 31 cai em sábado em 2026-01 (31/01/2026 é sábado) → desvio cai em fevereiro.
    const contract = base({ frequency: "monthly", starts_on: "2025-01-31" });
    const jan = getOccurrences(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(jan).toHaveLength(1);
    expect(jan[0].date.getMonth()).toBe(1); // fevereiro
    expect(jan[0].date.getDate()).toBe(2);
  });

  it("respeita ends_on mesmo após o desvio", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-01-17", ends_on: "2026-10-18" });
    const oct = getOccurrences(contract, new Date(2026, 9, 1), new Date(2026, 9, 31, 23, 59, 59));
    expect(oct).toHaveLength(0); // desvio cairia em 19/10, depois do fim do contrato
  });
});

// ─── personalizado ───────────────────────────────────────────────────────────

describe("getOccurrences — personalizado", () => {
  it("empurra ocorrência que cai em fim de semana", () => {
    const contract = base({ frequency: "custom", interval_days: 7, starts_on: "2026-07-18" }); // sábado
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.length).toBeGreaterThan(0);
    expect(occ[0].date.getDay()).not.toBe(0);
    expect(occ[0].date.getDay()).not.toBe(6);
  });

  it("nunca gera duas ocorrências no mesmo dia por causa do desvio (intervalo de 1 dia sáb+dom)", () => {
    const contract = base({ frequency: "custom", interval_days: 1, starts_on: "2026-07-17" }); // sexta
    const occ = getOccurrences(contract, new Date(2026, 6, 17), new Date(2026, 6, 21, 23, 59, 59));
    const dateStrs = occ.map((o) => o.date.toDateString());
    expect(new Set(dateStrs).size).toBe(dateStrs.length);
  });
});

// ─── semanal/quinzenal/3-em-3-semanas — NUNCA empurra (dia explícito) ────────

describe("getOccurrences — semanal/quinzenal/3-em-3-semanas nunca empurram fim de semana", () => {
  it("mantém sábado explicitamente escolhido em semanal", () => {
    const contract = base({ frequency: "weekly", weekdays: [6], starts_on: "2026-07-04" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((o) => o.date.getDay() === 6)).toBe(true);
  });

  it("triweekly repete de 3 em 3 semanas no dia escolhido", () => {
    const contract = base({ frequency: "triweekly", weekdays: [2], starts_on: "2026-07-07" }); // terça
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 8, 30, 23, 59, 59));
    expect(occ.every((o) => o.date.getDay() === 2)).toBe(true);
    // 07/07, depois +21 dias = 28/07, depois +21 = 18/08 ...
    const dates = occ.map((o) => o.date.getDate());
    expect(dates).toContain(7);
    expect(dates).toContain(28);
    expect(dates).not.toContain(14); // semana errada (cadência 3)
    expect(dates).not.toContain(21);
  });
});

// ─── diário — nunca gera em fim de semana (rótulo "todos os dias úteis") ────

describe("getOccurrences — diário salta fins de semana", () => {
  it("não inclui sábado/domingo", () => {
    const contract = base({ frequency: "daily", starts_on: "2026-07-01" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.some((o) => o.date.getDay() === 0 || o.date.getDay() === 6)).toBe(false);
  });
});
