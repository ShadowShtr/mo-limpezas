import { describe, it, expect } from "vitest";
import {
  iterateOccurrences,
  occurrencesInRange,
  occurrencesFrom,
  shiftToNextBusinessDay,
  type RecurrenceContract,
} from "@/domain/scheduling/recurrence-engine";
import type { ScheduleDay } from "@/types/database";

const SCHEDULE: ScheduleDay[] = [
  { day: "all", start_time: "09:00", duration_min: 120, team_id: "team-1" },
];

function base(overrides: Partial<RecurrenceContract>): RecurrenceContract {
  return {
    frequency: "monthly",
    weekdays: null,
    interval_days: 1,
    schedule_days: SCHEDULE,
    starts_on: "2026-01-15",
    ends_on: null,
    excluded_dates: [],
    ...overrides,
  };
}

// ─── bug corrigido: mensal em janela de vários meses ─────────────────────────

describe("occurrencesInRange — mensal em janela de vários meses", () => {
  it("gera uma ocorrência por mês quando a janela cobre 6 meses (bug histórico: só gerava 1 no total)", () => {
    // 15/01/2026 é quinta — nenhum mês desta janela cai em fim de semana no
    // dia 15, por isso todas as datas ficam exatamente no dia 15.
    const contract = base({ frequency: "monthly", starts_on: "2026-01-15" });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 5, 30, 23, 59, 59));

    expect(occ).toHaveLength(6);
    const months = occ.map((o) => o.date.getMonth());
    expect(months).toEqual([0, 1, 2, 3, 4, 5]);
    for (const o of occ) expect(o.date.getDate()).toBeGreaterThanOrEqual(15);
  });

  it("gera exatamente a mesma sequência que a janela usada em createContrato/updateContrato (3 meses)", () => {
    const anchor = new Date(2026, 0, 1); // âncora do mês
    const rangeEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 3, 0, 23, 59, 59);
    const contract = base({ frequency: "monthly", starts_on: "2026-01-15" });
    const occ = occurrencesInRange(contract, anchor, rangeEnd);
    expect(occ).toHaveLength(3);
    expect(occ.map((o) => o.date.getMonth())).toEqual([0, 1, 2]);
  });

  it("não gera ocorrência de meses antes do início do contrato mesmo com janela larga", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-03-10" });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 5, 30, 23, 59, 59));
    expect(occ).toHaveLength(4); // março, abril, maio, junho (não jan/fev)
    expect(occ[0].date.getMonth()).toBe(2);
  });

  it("respeita ends_on ao longo de várias iterações da janela", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-01-15", ends_on: "2026-03-20" });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 5, 30, 23, 59, 59));
    expect(occ).toHaveLength(3); // jan, fev, mar — não abril/maio/jun
    expect(occ.every((o) => o.date <= new Date(2026, 2, 20, 23, 59, 59))).toBe(true);
  });
});

// ─── shiftToNextBusinessDay ───────────────────────────────────────────────────

describe("shiftToNextBusinessDay", () => {
  it("empurra sábado para segunda (+2 dias)", () => {
    const sat = new Date(2026, 6, 18); // sábado
    const shifted = shiftToNextBusinessDay(sat);
    expect(shifted.getDay()).toBe(1);
  });

  it("empurra domingo para segunda (+1 dia)", () => {
    const sun = new Date(2026, 6, 19); // domingo
    const shifted = shiftToNextBusinessDay(sun);
    expect(shifted.getDay()).toBe(1);
  });

  it("não mexe em dia útil", () => {
    const wed = new Date(2026, 6, 15);
    expect(shiftToNextBusinessDay(wed).getTime()).toBe(wed.getTime());
  });
});

// ─── semanal / quinzenal / 3-em-3-semanas ────────────────────────────────────

describe("occurrencesInRange — semanal/quinzenal/3-em-3-semanas", () => {
  it("semanal repete todas as semanas nos dias escolhidos", () => {
    const contract = base({ frequency: "weekly", weekdays: [1, 4], starts_on: "2026-01-05" });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(occ.every((o) => [1, 4].includes(o.date.getDay()))).toBe(true);
    expect(occ.length).toBeGreaterThanOrEqual(8);
  });

  it("quinzenal salta a semana intermédia", () => {
    const contract = base({ frequency: "biweekly", weekdays: [2], starts_on: "2026-01-06" }); // terça
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 1, 28, 23, 59, 59));
    const dates = occ.map((o) => o.date.getDate());
    expect(dates).toContain(6);
    expect(dates).toContain(20);
    expect(dates).not.toContain(13); // semana errada
    expect(dates).not.toContain(27);
  });

  it("nunca empurra dia explícito de fim de semana", () => {
    const contract = base({ frequency: "weekly", weekdays: [6], starts_on: "2026-01-03" }); // sábado
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((o) => o.date.getDay() === 6)).toBe(true);
  });
});

// ─── personalizado ────────────────────────────────────────────────────────────

describe("occurrencesInRange — personalizado", () => {
  it("respeita o intervalo em dias a partir do início do contrato", () => {
    const contract = base({ frequency: "custom", interval_days: 10, starts_on: "2026-01-05" }); // segunda
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 1, 28, 23, 59, 59));
    const dates = occ.map((o) => o.date.getDate() + o.date.getMonth() * 100);
    // 05/01, 15/01, 25/01, 04/02, 14/02, 24/02
    expect(dates.length).toBeGreaterThanOrEqual(5);
  });

  it("nunca gera duas ocorrências no mesmo dia por causa do desvio", () => {
    const contract = base({ frequency: "custom", interval_days: 1, starts_on: "2026-01-16" }); // sexta
    const occ = occurrencesInRange(contract, new Date(2026, 0, 16), new Date(2026, 0, 20, 23, 59, 59));
    const strs = occ.map((o) => o.date.toDateString());
    expect(new Set(strs).size).toBe(strs.length);
  });
});

// ─── diário ───────────────────────────────────────────────────────────────────

describe("occurrencesInRange — diário", () => {
  it("nunca inclui sábado/domingo", () => {
    const contract = base({ frequency: "daily", starts_on: "2026-01-01" });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(occ.some((o) => o.date.getDay() === 0 || o.date.getDay() === 6)).toBe(false);
  });
});

// ─── occurrencesFrom (preview por contagem) ──────────────────────────────────

describe("occurrencesFrom", () => {
  it("devolve exatamente `count` ocorrências mensais mesmo atravessando anos", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-11-15" });
    const occ = occurrencesFrom(contract, new Date(2026, 10, 1), 5);
    expect(occ).toHaveLength(5);
    // nov/2026, dez/2026, jan/2027, fev/2027, mar/2027
    expect(occ.map((o) => `${o.date.getFullYear()}-${o.date.getMonth()}`)).toEqual([
      "2026-10", "2026-11", "2027-0", "2027-1", "2027-2",
    ]);
  });

  it("para no fim do contrato mesmo pedindo mais ocorrências do que existem", () => {
    const contract = base({ frequency: "weekly", weekdays: [1], starts_on: "2026-01-05", ends_on: "2026-01-19" });
    const occ = occurrencesFrom(contract, new Date(2026, 0, 1), 20);
    expect(occ.length).toBeLessThan(20);
    expect(occ.every((o) => o.date <= new Date(2026, 0, 19, 23, 59, 59))).toBe(true);
  });
});

// ─── DST (mudança de hora em Portugal, último domingo de março/outubro) ─────

describe("DST — transições de hora não perdem nem duplicam dias", () => {
  it("diário atravessa o início do horário de verão (2026-03-29) sem saltar nem duplicar", () => {
    const contract = base({ frequency: "daily", starts_on: "2026-03-23" });
    const occ = occurrencesInRange(contract, new Date(2026, 2, 23), new Date(2026, 2, 31, 23, 59, 59));
    const dates = occ.map((o) => o.date.getDate());
    // dias úteis de 23 a 31 de março de 2026 (sáb 28 e dom 29 ficam de fora)
    expect(dates).toEqual([23, 24, 25, 26, 27, 30, 31]);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("semanal atravessa o fim do horário de verão (2026-10-25) sem saltar nem duplicar a semana", () => {
    const contract = base({ frequency: "weekly", weekdays: [1], starts_on: "2026-10-05" });
    const occ = occurrencesInRange(contract, new Date(2026, 9, 1), new Date(2026, 10, 15, 23, 59, 59));
    const dates = occ.map((o) => o.date.getDate() + o.date.getMonth() * 100);
    // getMonth() é 0-indexado: outubro=9, novembro=10.
    expect(dates).toEqual([905, 912, 919, 926, 1002, 1009]); // 05,12,19,26/out, 02,09/nov
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("mensal com dia-âncora perto da transição de outubro continua a gerar 1x por mês", () => {
    const contract = base({ frequency: "monthly", starts_on: "2026-08-31" });
    const occ = occurrencesInRange(contract, new Date(2026, 7, 1), new Date(2026, 10, 30, 23, 59, 59));
    expect(occ).toHaveLength(4); // ago, set, out, nov
    const months = occ.map((o) => o.date.getMonth());
    expect(new Set(months).size).toBe(4);
  });
});

// ─── invariantes gerais ───────────────────────────────────────────────────────

describe("invariantes", () => {
  const frequencies: Array<Partial<RecurrenceContract>> = [
    { frequency: "daily" },
    { frequency: "weekly", weekdays: [1, 3, 5] },
    { frequency: "biweekly", weekdays: [2] },
    { frequency: "triweekly", weekdays: [4] },
    { frequency: "monthly" },
    { frequency: "custom", interval_days: 9 },
  ];

  it.each(frequencies)("$frequency: nunca gera datas duplicadas nem fora de ordem", (overrides) => {
    const contract = base({ starts_on: "2026-01-05", ...overrides });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 11, 31, 23, 59, 59));
    const seen = new Set<string>();
    let prev: Date | null = null;
    for (const o of occ) {
      const key = o.date.toDateString();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (prev) expect(o.date.getTime()).toBeGreaterThan(prev.getTime());
      prev = o.date;
    }
  });

  it.each(frequencies)("$frequency: iterateOccurrences e occurrencesInRange concordam no prefixo dentro da janela", (overrides) => {
    const contract = base({ starts_on: "2026-01-05", ...overrides });
    const rangeStart = new Date(2026, 0, 1);
    const rangeEnd = new Date(2026, 2, 31, 23, 59, 59);
    const viaRange = occurrencesInRange(contract, rangeStart, rangeEnd).map((o) => o.date.getTime());

    const viaGenerator: number[] = [];
    for (const o of iterateOccurrences(contract, rangeStart)) {
      if (o.date > rangeEnd) break;
      viaGenerator.push(o.date.getTime());
    }
    expect(viaGenerator).toEqual(viaRange);
  });

  it("respeita exclusões manuais em qualquer frequência", () => {
    const contract = base({ frequency: "weekly", weekdays: [1], starts_on: "2026-01-05", excluded_dates: ["2026-01-12"] });
    const occ = occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59));
    expect(occ.some((o) => o.date.getDate() === 12)).toBe(false);
  });

  it("devolve lista vazia sem schedule_days", () => {
    const contract = base({ schedule_days: [] });
    expect(occurrencesInRange(contract, new Date(2026, 0, 1), new Date(2026, 0, 31))).toEqual([]);
  });
});
