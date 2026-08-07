// Aritmética de datas civis — a base do motor de recorrência.
//
// O ponto destes testes é que nada aqui pode depender do fuso do processo nem
// do horário de verão. Somar 7 dias tem de dar 7 dias em março e em agosto.

import { describe, it, expect } from "vitest";
import {
  addDays,
  addMonths,
  civilDate,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  fromEpochDay,
  fromLocalDate,
  isValidCivilDate,
  isWeekend,
  partsOf,
  startOfMonth,
  startOfWeek,
  toEpochDay,
  toLocalDate,
} from "@/domain/scheduling/civil-date";

describe("isValidCivilDate", () => {
  it.each([
    "2026-01-01", "2026-12-31", "2024-02-29", "2026-02-28", "2000-02-29",
  ])("aceita %s", (value) => {
    expect(isValidCivilDate(value)).toBe(true);
  });

  it.each([
    ["2026-02-29", "fevereiro comum não tem 29"],
    ["2026-02-30", "fevereiro nunca tem 30"],
    ["2026-04-31", "abril não tem 31"],
    ["1900-02-29", "1900 não é bissexto (regra dos 400)"],
    ["72026-01-01", "ano com um dígito a mais — corrupção real de produção"],
    ["2026-13-01", "mês 13"],
    ["2026-00-01", "mês 0"],
    ["2026-01-00", "dia 0"],
    ["2026-1-01", "sem zeros à esquerda"],
    ["2026-01-01T00:00:00", "com hora"],
    ["", "vazio"],
  ])("rejeita %s (%s)", (value) => {
    expect(isValidCivilDate(value)).toBe(false);
  });

  it("rejeita o que não é string", () => {
    expect(isValidCivilDate(null)).toBe(false);
    expect(isValidCivilDate(undefined)).toBe(false);
    expect(isValidCivilDate(20260101)).toBe(false);
    expect(isValidCivilDate(new Date())).toBe(false);
  });
});

describe("daysInMonth", () => {
  it.each([
    [2026, 1, 31], [2026, 2, 28], [2026, 4, 30], [2026, 12, 31],
    [2024, 2, 29], [2000, 2, 29], [1900, 2, 28], [2100, 2, 28],
  ])("%i-%i tem %i dias", (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe("civilDate — clamp em vez de transbordo", () => {
  it("limita o dia 31 ao último dia do mês", () => {
    expect(civilDate(2026, 2, 31)).toBe("2026-02-28");
    expect(civilDate(2024, 2, 31)).toBe("2024-02-29");
    expect(civilDate(2026, 4, 31)).toBe("2026-04-30");
  });

  it("não mexe num dia válido", () => {
    expect(civilDate(2026, 3, 31)).toBe("2026-03-31");
  });

  it("nunca transborda para o mês seguinte (o que o Date faz)", () => {
    // `new Date(2026, 1, 31)` é 3 de março — a origem do defeito.
    expect(new Date(2026, 1, 31).getMonth()).toBe(2);
    expect(civilDate(2026, 2, 31).startsWith("2026-02")).toBe(true);
  });
});

describe("addDays", () => {
  it("soma e subtrai dentro do mês", () => {
    expect(addDays("2026-07-01", 5)).toBe("2026-07-06");
    expect(addDays("2026-07-06", -5)).toBe("2026-07-01");
  });

  it("atravessa meses e anos", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("atravessa 29 de fevereiro em ano bissexto", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("somar 7 dias dá sempre 7 dias, mesmo sobre a mudança de hora", () => {
    // Portugal muda a hora a 29/03/2026 e a 25/10/2026.
    expect(addDays("2026-03-25", 7)).toBe("2026-04-01");
    expect(addDays("2026-10-22", 7)).toBe("2026-10-29");
    expect(daysBetween("2026-03-25", addDays("2026-03-25", 7))).toBe(7);
    expect(daysBetween("2026-10-22", addDays("2026-10-22", 7))).toBe(7);
  });

  it("zero dias devolve a mesma data", () => {
    expect(addDays("2026-07-01", 0)).toBe("2026-07-01");
  });
});

describe("daysBetween", () => {
  it("conta dias inteiros", () => {
    expect(daysBetween("2026-07-01", "2026-07-08")).toBe(7);
    expect(daysBetween("2026-07-08", "2026-07-01")).toBe(-7);
    expect(daysBetween("2026-07-01", "2026-07-01")).toBe(0);
  });

  it("conta anos completos", () => {
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366); // bissexto
  });
});

describe("dayOfWeek / isWeekend", () => {
  it.each([
    ["2026-07-05", 0], ["2026-07-06", 1], ["2026-07-07", 2], ["2026-07-08", 3],
    ["2026-07-09", 4], ["2026-07-10", 5], ["2026-07-11", 6],
  ])("%s → %i", (date, expected) => {
    expect(dayOfWeek(date)).toBe(expected);
  });

  it("concorda com o Date construído localmente", () => {
    for (const d of ["2026-01-01", "2026-03-29", "2026-10-25", "2027-02-15", "2024-02-29"]) {
      expect(dayOfWeek(d)).toBe(toLocalDate(d).getDay());
    }
  });

  it("identifica o fim de semana", () => {
    expect(isWeekend("2026-07-11")).toBe(true); // sábado
    expect(isWeekend("2026-07-12")).toBe(true); // domingo
    expect(isWeekend("2026-07-13")).toBe(false); // segunda
  });
});

describe("startOfWeek — a semana começa à segunda", () => {
  it.each([
    ["2026-07-06", "2026-07-06"], // segunda → ela própria
    ["2026-07-08", "2026-07-06"], // quarta
    ["2026-07-11", "2026-07-06"], // sábado
    ["2026-07-12", "2026-07-06"], // domingo pertence à semana que começou dia 6
  ])("%s → %s", (date, expected) => {
    expect(startOfWeek(date)).toBe(expected);
  });

  it("atravessa a mudança de ano", () => {
    expect(startOfWeek("2027-01-01")).toBe("2026-12-28");
  });
});

describe("meses", () => {
  it("startOfMonth", () => {
    expect(startOfMonth("2026-07-31")).toBe("2026-07-01");
  });

  it("addMonths atravessa o ano em ambos os sentidos", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-01");
    expect(addMonths("2026-02-15", -3)).toBe("2025-11-01");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
  });

});

describe("epoch day", () => {
  it("ida e volta", () => {
    for (const d of ["1970-01-01", "2026-07-01", "1999-12-31", "2100-03-01"]) {
      expect(fromEpochDay(toEpochDay(d))).toBe(d);
    }
  });

  it("a época é uma quinta-feira", () => {
    expect(toEpochDay("1970-01-01")).toBe(0);
    expect(dayOfWeek("1970-01-01")).toBe(4);
  });
});

describe("fronteira com Date", () => {
  it("toLocalDate/fromLocalDate são inversos", () => {
    for (const d of ["2026-01-01", "2026-07-01", "2026-03-29", "2026-10-25", "2024-02-29"]) {
      expect(fromLocalDate(toLocalDate(d))).toBe(d);
    }
  });

  it("toLocalDate devolve meia-noite local, não UTC", () => {
    const d = toLocalDate("2026-07-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it("fromLocalDate lê o dia que o Date MOSTRA, não o dia em UTC", () => {
    // Este é o defeito que `.toISOString().slice(0, 10)` provoca: numa máquina
    // a leste de Greenwich a meia-noite local é o dia anterior em UTC.
    const meiaNoiteLocal = new Date(2026, 6, 15, 0, 0, 0);
    expect(fromLocalDate(meiaNoiteLocal)).toBe("2026-07-15");
  });

  it("ignora a hora do Date", () => {
    expect(fromLocalDate(new Date(2026, 6, 15, 23, 59, 59))).toBe("2026-07-15");
  });
});

describe("partsOf", () => {
  it("devolve números, não strings", () => {
    expect(partsOf("2026-07-05")).toEqual({ year: 2026, month: 7, day: 5 });
  });
});
