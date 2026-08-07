// Adaptador entre o motor canónico e os consumidores que usam `Date`.
//
// A regra da recorrência está coberta em `recurrence-engine.test.ts`. Aqui
// testa-se só o que este ficheiro faz: converter `Date` ↔ data civil na
// fronteira e escolher o horário certo para cada ocorrência.
//
// Os casos de regressão que já existiam antes da Task T07 ficam todos, agora
// através do motor — foram eles que provaram que o comportamento visível não
// mudou onde não devia mudar.

import { describe, it, expect } from "vitest";
import { getOccurrences, toRecurrenceRule, DOW_TO_KEY, type OccurrenceContract } from "@/lib/contract-occurrences";
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

const dias = (occ: Array<{ date: Date }>) =>
  occ.map((o) => `${o.date.getFullYear()}-${String(o.date.getMonth() + 1).padStart(2, "0")}-${String(o.date.getDate()).padStart(2, "0")}`);

// ─── tradução da regra ──────────────────────────────────────────────────────

describe("toRecurrenceRule", () => {
  it("traduz os campos da base para a regra do motor", () => {
    const contract = base({
      frequency: "biweekly",
      weekdays: [1, 3],
      interval_days: 5,
      starts_on: "2026-07-06",
      ends_on: "2026-12-31",
      excluded_dates: ["2026-08-03"],
    });
    expect(toRecurrenceRule(contract)).toEqual({
      frequency: "biweekly",
      weekdays: [1, 3],
      intervalDays: 5,
      startsOn: "2026-07-06",
      endsOn: "2026-12-31",
      excludedDates: ["2026-08-03"],
    });
  });
});

// ─── fronteira Date ─────────────────────────────────────────────────────────

describe("fronteira com Date", () => {
  it("lê o intervalo pelos campos LOCAIS do Date", () => {
    const contract = base({ frequency: "daily", starts_on: "2026-07-01" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 3, 23, 59, 59));
    expect(dias(occ)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  it("devolve Date à meia-noite local", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-07-15" });
    const [occ] = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.date.getHours()).toBe(0);
    expect(occ.date.getMinutes()).toBe(0);
    expect(occ.date.getDate()).toBe(15);
  });

  it("sem schedule_days não gera nada", () => {
    const contract = base({ frequency: "daily", schedule_days: [] });
    expect(getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31))).toEqual([]);
  });
});

// ─── escolha do horário ─────────────────────────────────────────────────────

describe("horário de cada ocorrência", () => {
  it("com vários dias, cada dia leva o seu horário e a sua equipa", () => {
    const schedule: ScheduleDay[] = [
      { day: "mon", start_time: "08:00", duration_min: 60, team_id: "equipa-A" },
      { day: "wed", start_time: "14:00", duration_min: 180, team_id: "equipa-B" },
    ];
    const contract = base({
      frequency: "weekly", weekdays: [1, 3], schedule_days: schedule, starts_on: "2026-07-06",
    });
    const occ = getOccurrences(contract, new Date(2026, 6, 6), new Date(2026, 6, 8, 23, 59, 59));
    expect(occ).toHaveLength(2);
    expect(occ[0].schedule.team_id).toBe("equipa-A");
    expect(occ[0].schedule.start_time).toBe("08:00");
    expect(occ[1].schedule.team_id).toBe("equipa-B");
    expect(occ[1].schedule.start_time).toBe("14:00");
  });

  it("sem horário para o dia, usa o primeiro (o caso `day: \"all\"`)", () => {
    const contract = base({ frequency: "weekly", weekdays: [1], starts_on: "2026-07-06" });
    const occ = getOccurrences(contract, new Date(2026, 6, 6), new Date(2026, 6, 6, 23, 59, 59));
    expect(occ[0].schedule.team_id).toBe("team-1");
  });

  it("DOW_TO_KEY cobre a semana toda", () => {
    expect(Object.keys(DOW_TO_KEY)).toHaveLength(7);
    expect(DOW_TO_KEY[0]).toBe("sun");
    expect(DOW_TO_KEY[6]).toBe("sat");
  });
});

// ─── regressões anteriores à T07 (comportamento visível preservado) ─────────

describe("regressões preservadas", () => {
  it("mensal gera no dia do mês quando cai em dia útil", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-07-15" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(dias(occ)).toEqual(["2026-07-15"]);
  });

  it("mensal empurra para segunda quando o dia cai em fim de semana (17/10 sábado)", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-01-17" });
    const occ = getOccurrences(contract, new Date(2026, 9, 1), new Date(2026, 9, 31, 23, 59, 59));
    expect(dias(occ)).toEqual(["2026-10-19"]);
  });

  it("mensal mantém a ocorrência quando o desvio ultrapassa o fim do mês pedido", () => {
    const contract = base({ frequency: "monthly", starts_on: "2025-01-31" });
    const occ = getOccurrences(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(dias(occ)).toEqual(["2026-02-02"]);
  });

  it("mensal respeita ends_on mesmo após o desvio", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-01-17", ends_on: "2026-10-18" });
    const occ = getOccurrences(contract, new Date(2026, 9, 1), new Date(2026, 9, 31, 23, 59, 59));
    expect(occ).toHaveLength(0);
  });

  it("personalizado empurra ocorrência que cai em fim de semana", () => {
    const contract = base({ frequency: "custom", interval_days: 7, starts_on: "2026-07-18" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((o) => o.date.getDay() !== 0 && o.date.getDay() !== 6)).toBe(true);
  });

  it("personalizado nunca gera duas ocorrências no mesmo dia", () => {
    const contract = base({ frequency: "custom", interval_days: 1, starts_on: "2026-07-17" });
    const occ = getOccurrences(contract, new Date(2026, 6, 17), new Date(2026, 6, 21, 23, 59, 59));
    expect(new Set(dias(occ)).size).toBe(occ.length);
  });

  it("semanal mantém sábado explicitamente escolhido", () => {
    const contract = base({ frequency: "weekly", weekdays: [6], starts_on: "2026-07-04" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((o) => o.date.getDay() === 6)).toBe(true);
  });

  it("triweekly repete de 3 em 3 semanas no dia escolhido", () => {
    const contract = base({ frequency: "triweekly", weekdays: [2], starts_on: "2026-07-07" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 8, 30, 23, 59, 59));
    expect(occ.every((o) => o.date.getDay() === 2)).toBe(true);
    const numeros = occ.map((o) => o.date.getDate());
    expect(numeros).toContain(7);
    expect(numeros).toContain(28);
    expect(numeros).not.toContain(14);
    expect(numeros).not.toContain(21);
  });

  it("diário nunca inclui fim de semana", () => {
    const contract = base({ frequency: "daily", starts_on: "2026-07-01" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31, 23, 59, 59));
    expect(occ.some((o) => o.date.getDay() === 0 || o.date.getDay() === 6)).toBe(false);
  });
});

// ─── correções trazidas pela T07 ────────────────────────────────────────────

describe("correções da T07 visíveis através do wrapper", () => {
  it("mensal gera em TODOS os meses do intervalo (antes: só no primeiro)", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-07-15" });
    const occ = getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 11, 31, 23, 59, 59));
    expect(dias(occ)).toEqual([
      "2026-07-15", "2026-08-17", "2026-09-15", "2026-10-15", "2026-11-16", "2026-12-15",
    ]);
  });

  it("dia 31 não transborda nem arrasta a âncora", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-01-31" });
    const occ = getOccurrences(contract, new Date(2026, 0, 1), new Date(2026, 5, 30, 23, 59, 59));
    expect(dias(occ)).toEqual([
      "2026-02-02", "2026-03-02", "2026-03-31", "2026-04-30", "2026-06-01", "2026-06-30",
    ]);
  });

  it("contrato com data corrompida não gera nada em vez de rebentar", () => {
    const contract = base({ frequency: "monthly", starts_on: "72026-01-01" });
    expect(getOccurrences(contract, new Date(2026, 6, 1), new Date(2026, 6, 31))).toEqual([]);
  });
});
