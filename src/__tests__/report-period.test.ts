// T14 — Períodos civis e interseção.
//
// O que estes testes protegem: um registo que atravessa a fronteira do
// relatório tem de contribuir apenas com os dias que estão dentro dele. É a
// operação que falta em todo o código de relatórios actual.

import { describe, it, expect } from "vitest";
import {
  containsDate,
  coversWholeMonthOf,
  dayPeriod,
  eachDay,
  intersectPeriods,
  intersectionDays,
  intersectionFraction,
  isWholeMonth,
  makePeriod,
  monthPeriod,
  monthPeriodOf,
  monthsCovered,
  periodDays,
  periodKey,
  periodsOverlap,
} from "@/domain/reports/period";

const AGOSTO = monthPeriod(2026, 8)!;

describe("makePeriod", () => {
  it("aceita um intervalo válido", () => {
    expect(makePeriod("2026-08-01", "2026-08-31")).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
  });

  it("aceita um período de um único dia", () => {
    expect(makePeriod("2026-08-05", "2026-08-05")).not.toBeNull();
  });

  it("recusa um intervalo invertido em vez de o corrigir", () => {
    // Trocar as pontas em silêncio faria um dado corrompido produzir um número
    // plausível. O `null` obriga quem chama a registar INVALID_DATE_RANGE.
    expect(makePeriod("2026-08-31", "2026-08-01")).toBeNull();
  });

  it("recusa o ano com um dígito a mais que já corrompeu contratos reais", () => {
    expect(makePeriod("72026-01-01", "72026-01-31")).toBeNull();
  });

  it("recusa datas que o Date aceitaria por rollover", () => {
    expect(makePeriod("2026-02-30", "2026-03-01")).toBeNull();
  });

  it("recusa valores que não são datas", () => {
    expect(makePeriod(null, "2026-08-01")).toBeNull();
    expect(makePeriod("2026-08-01", undefined)).toBeNull();
    expect(makePeriod(20260801, "2026-08-31")).toBeNull();
  });
});

describe("periodDays", () => {
  it("conta o intervalo fechado dos dois lados", () => {
    expect(periodDays(dayPeriod("2026-08-05")!)).toBe(1);
    expect(periodDays(AGOSTO)).toBe(31);
    expect(periodDays(monthPeriod(2026, 2)!)).toBe(28);
    expect(periodDays(monthPeriod(2028, 2)!)).toBe(29);
  });
});

describe("intersectPeriods", () => {
  it("devolve a parte comum", () => {
    const registo = makePeriod("2026-07-20", "2026-08-05")!;
    expect(intersectPeriods(registo, AGOSTO)).toEqual({
      start: "2026-08-01",
      end: "2026-08-05",
    });
  });

  it("é comutativa", () => {
    const a = makePeriod("2026-07-20", "2026-08-05")!;
    expect(intersectPeriods(a, AGOSTO)).toEqual(intersectPeriods(AGOSTO, a));
  });

  it("devolve null quando os períodos apenas se seguem", () => {
    // Agosto termina a 31, setembro começa a 1: nenhum dia partilhado.
    expect(intersectPeriods(AGOSTO, monthPeriod(2026, 9)!)).toBeNull();
    expect(periodsOverlap(AGOSTO, monthPeriod(2026, 9)!)).toBe(false);
  });

  it("devolve o próprio período quando um contém o outro", () => {
    const dentro = makePeriod("2026-08-10", "2026-08-12")!;
    expect(intersectPeriods(dentro, AGOSTO)).toEqual(dentro);
  });
});

describe("intersectionDays", () => {
  it("conta só os dias dentro da janela", () => {
    const baixa = makePeriod("2026-08-01", "2026-09-30")!;
    expect(periodDays(baixa)).toBe(61);
    expect(intersectionDays(baixa, AGOSTO)).toBe(31);
    expect(intersectionDays(baixa, monthPeriod(2026, 9)!)).toBe(30);
  });

  it("a soma sobre meses consecutivos dá a duração real, sem dupla contagem", () => {
    // É esta a invariante que o código actual quebra: soma 61 + 61 = 122 para
    // uma ausência de 61 dias.
    const baixa = makePeriod("2026-08-01", "2026-09-30")!;
    const soma = intersectionDays(baixa, AGOSTO) + intersectionDays(baixa, monthPeriod(2026, 9)!);
    expect(soma).toBe(periodDays(baixa));
  });

  it("a soma fecha mesmo quando o registo atravessa três meses", () => {
    const longa = makePeriod("2026-07-15", "2026-09-10")!;
    const soma = [7, 8, 9]
      .map((m) => intersectionDays(longa, monthPeriod(2026, m)!))
      .reduce((a, b) => a + b, 0);
    expect(soma).toBe(periodDays(longa));
  });

  it("dá zero quando não se tocam", () => {
    expect(intersectionDays(makePeriod("2026-05-01", "2026-05-10")!, AGOSTO)).toBe(0);
  });

  it("conta 1 quando só a fronteira coincide", () => {
    expect(intersectionDays(makePeriod("2026-07-01", "2026-08-01")!, AGOSTO)).toBe(1);
    expect(intersectionDays(makePeriod("2026-08-31", "2026-09-15")!, AGOSTO)).toBe(1);
  });

  it("cobre a janela inteira quando o registo a engloba", () => {
    const anual = makePeriod("2026-01-01", "2026-12-31")!;
    expect(intersectionDays(anual, AGOSTO)).toBe(31);
  });
});

describe("intersectionFraction", () => {
  it("dá 1 quando o registo cabe todo na janela", () => {
    expect(intersectionFraction(makePeriod("2026-08-10", "2026-08-12")!, AGOSTO)).toBe(1);
  });

  it("dá a fração quando o registo transborda", () => {
    const registo = makePeriod("2026-08-30", "2026-09-02")!; // 4 dias, 2 em agosto
    expect(intersectionFraction(registo, AGOSTO)).toBeCloseTo(0.5, 10);
  });

  it("dá 0 quando não se tocam", () => {
    expect(intersectionFraction(makePeriod("2026-05-01", "2026-05-02")!, AGOSTO)).toBe(0);
  });
});

describe("eachDay", () => {
  it("devolve todos os dias, incluindo os vazios", () => {
    const dias = eachDay(AGOSTO);
    expect(dias).toHaveLength(31);
    expect(dias[0]).toBe("2026-08-01");
    expect(dias[30]).toBe("2026-08-31");
  });

  it("atravessa a mudança de hora sem perder nem repetir dias", () => {
    // Em Portugal a hora de verão termina no último domingo de outubro. Como a
    // aritmética é civil (Date.UTC), o dia da mudança não é especial.
    const outubro = monthPeriod(2026, 10)!;
    const dias = eachDay(outubro);
    expect(dias).toHaveLength(31);
    expect(new Set(dias).size).toBe(31);
    expect(dias).toContain("2026-10-25");
  });

  it("atravessa a fronteira do ano", () => {
    const dias = eachDay(makePeriod("2026-12-30", "2027-01-02")!);
    expect(dias).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});

describe("monthsCovered", () => {
  it("devolve um mês para uma janela dentro do mês", () => {
    expect(monthsCovered(makePeriod("2026-08-05", "2026-08-07")!)).toHaveLength(1);
  });

  it("devolve os dois meses de uma semana a cavalo", () => {
    // O caso que fez o Dashboard Financeiro usar um denominador errado.
    const semana = makePeriod("2026-07-27", "2026-08-02")!;
    const meses = monthsCovered(semana);
    expect(meses.map(periodKey)).toEqual(["2026-07", "2026-08"]);
  });

  it("atravessa a fronteira do ano", () => {
    const meses = monthsCovered(makePeriod("2026-11-15", "2027-02-10")!);
    expect(meses.map(periodKey)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe("coversWholeMonthOf", () => {
  it("é verdadeiro quando a janela é o mês inteiro", () => {
    expect(coversWholeMonthOf(AGOSTO, "2026-08-15")).toBe(true);
  });

  it("é falso para a semana a cavalo de dois meses", () => {
    // Sem esta verificação, o denominador da avença sai dos dados carregados e
    // o valor por serviço fica inflacionado.
    const semana = makePeriod("2026-07-27", "2026-08-02")!;
    expect(coversWholeMonthOf(semana, "2026-08-01")).toBe(false);
    expect(coversWholeMonthOf(semana, "2026-07-30")).toBe(false);
  });

  it("é falso para um único dia", () => {
    expect(coversWholeMonthOf(dayPeriod("2026-08-15")!, "2026-08-15")).toBe(false);
  });
});

describe("periodKey e isWholeMonth", () => {
  it("usa a data quando é um só dia", () => {
    expect(periodKey(dayPeriod("2026-08-05")!)).toBe("2026-08-05");
  });

  it("usa o mês quando é um mês completo", () => {
    expect(periodKey(AGOSTO)).toBe("2026-08");
    expect(isWholeMonth(AGOSTO)).toBe(true);
    expect(isWholeMonth(monthPeriod(2026, 2)!)).toBe(true);
  });

  it("usa o intervalo quando não é nem uma coisa nem outra", () => {
    expect(periodKey(makePeriod("2026-08-01", "2026-08-15")!)).toBe("2026-08-01..2026-08-15");
    expect(isWholeMonth(makePeriod("2026-08-01", "2026-08-30")!)).toBe(false);
  });
});

describe("containsDate e monthPeriodOf", () => {
  it("inclui os extremos", () => {
    expect(containsDate(AGOSTO, "2026-08-01")).toBe(true);
    expect(containsDate(AGOSTO, "2026-08-31")).toBe(true);
    expect(containsDate(AGOSTO, "2026-07-31")).toBe(false);
    expect(containsDate(AGOSTO, "2026-09-01")).toBe(false);
  });

  it("rejeita datas inválidas em vez de as aceitar por acaso", () => {
    expect(containsDate(AGOSTO, "2026-08-32")).toBe(false);
  });

  it("monthPeriodOf devolve o mês da data", () => {
    expect(monthPeriodOf("2026-02-15")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthPeriodOf("2028-02-15")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthPeriodOf("lixo")).toBeNull();
  });

  it("monthPeriod recusa meses fora do intervalo", () => {
    expect(monthPeriod(2026, 0)).toBeNull();
    expect(monthPeriod(2026, 13)).toBeNull();
    expect(monthPeriod(2026.5, 8)).toBeNull();
  });
});
