// ============================================================================
// COMPATIBILIDADE: ALGORITMO ANTERIOR À T07 × MOTOR CANÓNICO
// ============================================================================
// O PR #46 (T07) não pode ir a merge enquanto não soubermos QUE contratos
// existentes mudam de datas. Estes testes medem essa diferença.
//
// O achado central, e não é o horário de verão:
//
// O algoritmo antigo agrupava semanas com `floor(timestamp / 7 dias)`. Essa
// divisão conta desde a época Unix, e 1970-01-01 foi uma QUINTA-FEIRA — logo a
// fronteira entre "semanas" do algoritmo antigo caía à quinta, repartindo cada
// semana civil em dois baldes: segunda–quarta num, quinta–domingo no seguinte.
//
// Consequência exata, medida abaixo: um contrato quinzenal ou de 3 em 3
// semanas muda de paridade se e só se o dia escolhido e o dia de início
// ficarem em lados opostos dessa fronteira. Sem DST nenhum envolvido.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  cadenceParityShifts,
  compareContract,
  compareContracts,
  ruleChanges,
  type CompatContract,
} from "@/domain/scheduling/recurrence-compat";
import { legacyOccurrencesInRange } from "@/domain/scheduling/legacy-recurrence";
import { occurrencesInRange } from "@/domain/scheduling/recurrence-engine";
import { addDays, dayOfWeek } from "@/domain/scheduling/civil-date";

function contract(over: Partial<CompatContract> & { frequency: string }): CompatContract {
  return {
    id: "c1",
    weekdays: null,
    intervalDays: 1,
    startsOn: "2026-01-05", // segunda-feira
    endsOn: null,
    excludedDates: [],
    ...over,
  };
}

const ANO_2026 = { start: "2026-01-01", end: "2026-12-31" };

// ─── o motor legacy reproduz mesmo os defeitos antigos ──────────────────────

describe("motor legacy congelado", () => {
  it("mensal só gera no mês de range.start (defeito original preservado)", () => {
    const rule = { frequency: "monthly", weekdays: null, intervalDays: 1, startsOn: "2026-07-15", endsOn: null, excludedDates: [] };
    const legacy = legacyOccurrencesInRange(rule, { start: "2026-07-01", end: "2026-12-31" });
    expect(legacy).toEqual(["2026-07-15"]);
    // O canónico gera nos seis meses.
    expect(occurrencesInRange(rule, { start: "2026-07-01", end: "2026-12-31" })).toHaveLength(6);
  });

  it("dia 31 transbordava para o mês seguinte (defeito original preservado)", () => {
    const rule = { frequency: "monthly", weekdays: null, intervalDays: 1, startsOn: "2026-01-31", endsOn: null, excludedDates: [] };
    // Fevereiro de 2026 não tem 31: o `Date` antigo dava 3 de março.
    expect(legacyOccurrencesInRange(rule, { start: "2026-02-01", end: "2026-02-28" }))
      .toEqual(["2026-03-03"]);
    // O canónico limita a 28/02 (sábado) e empurra para segunda 02/03.
    expect(occurrencesInRange(rule, { start: "2026-02-01", end: "2026-02-28" }))
      .toEqual(["2026-02-02", "2026-03-02"]);
  });

  it("diário e semanal são idênticos nos dois motores", () => {
    for (const freq of ["daily", "weekly"]) {
      const rule = {
        frequency: freq,
        weekdays: freq === "weekly" ? [1, 4] : null,
        intervalDays: 1,
        startsOn: "2026-01-05",
        endsOn: null,
        excludedDates: [],
      };
      expect(legacyOccurrencesInRange(rule, ANO_2026)).toEqual(occurrencesInRange(rule, ANO_2026));
    }
  });
});

// ─── a matriz que responde à pergunta do #46 ────────────────────────────────

describe("matriz de paridade: quinzenal e 3 em 3 semanas", () => {
  const CADENCIAS = ["biweekly", "triweekly"] as const;

  it("a fórmula concorda com a medição, em todas as 49 combinações", () => {
    // Se a fórmula e o comparador empírico divergirem, nenhum dos dois é de
    // confiança — por isso os dois têm de dar sempre o mesmo veredicto.
    for (const frequency of CADENCIAS) {
      for (let offset = 0; offset < 7; offset++) {
        const startsOn = addDays("2026-01-05", offset);
        for (let weekday = 0; weekday < 7; weekday++) {
          const medido = compareContract(
            contract({ frequency, weekdays: [weekday], startsOn }),
            { start: startsOn, end: "2026-12-31" },
          ).changed;
          const previsto = cadenceParityShifts(dayOfWeek(startsOn), weekday);
          expect(
            medido,
            `${frequency} início=${startsOn} dia=${weekday}`,
          ).toBe(previsto);
        }
      }
    }
  });

  it("início a uma segunda: muda para quinta, sexta, sábado e domingo", () => {
    const mudam: number[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      if (compareContract(
        contract({ frequency: "biweekly", weekdays: [weekday], startsOn: "2026-01-05" }),
        { start: "2026-01-05", end: "2026-12-31" },
      ).changed) mudam.push(weekday);
    }
    expect(mudam.sort()).toEqual([0, 4, 5, 6]); // dom, qui, sex, sáb
  });

  it("início a uma quinta: muda para segunda, terça e quarta", () => {
    const mudam: number[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      if (compareContract(
        contract({ frequency: "biweekly", weekdays: [weekday], startsOn: "2026-01-08" }),
        { start: "2026-01-08", end: "2026-12-31" },
      ).changed) mudam.push(weekday);
    }
    expect(mudam.sort()).toEqual([1, 2, 3]);
  });

  it("segunda, terça e quarta comportam-se todas da mesma maneira", () => {
    const perfil = (startsOn: string) =>
      [0, 1, 2, 3, 4, 5, 6].map((w) => compareContract(
        contract({ frequency: "triweekly", weekdays: [w], startsOn }),
        { start: startsOn, end: "2026-12-31" },
      ).changed);
    expect(perfil("2026-01-05")).toEqual(perfil("2026-01-06"));
    expect(perfil("2026-01-06")).toEqual(perfil("2026-01-07"));
  });

  it("quinta a domingo comportam-se todas da mesma maneira", () => {
    const perfil = (startsOn: string) =>
      [0, 1, 2, 3, 4, 5, 6].map((w) => compareContract(
        contract({ frequency: "triweekly", weekdays: [w], startsOn }),
        { start: startsOn, end: "2026-12-31" },
      ).changed);
    expect(perfil("2026-01-08")).toEqual(perfil("2026-01-09"));
    expect(perfil("2026-01-09")).toEqual(perfil("2026-01-10"));
    expect(perfil("2026-01-10")).toEqual(perfil("2026-01-11"));
  });

  it("deslocar o início uma semana inteira não altera o veredicto", () => {
    // Se alterasse, o efeito dependeria do calendário e não seria previsível.
    for (const frequency of CADENCIAS) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const base = compareContract(
          contract({ frequency, weekdays: [weekday], startsOn: "2026-01-05" }),
          { start: "2026-01-05", end: "2026-12-31" },
        ).changed;
        for (const semanas of [1, 2, 5, 13, 40]) {
          const startsOn = addDays("2026-01-05", semanas * 7);
          expect(compareContract(
            contract({ frequency, weekdays: [weekday], startsOn }),
            { start: startsOn, end: "2026-12-31" },
          ).changed).toBe(base);
        }
      }
    }
  });

  it("o veredicto não depende do horário de verão", () => {
    // Janelas inteiramente dentro do inverno e inteiramente dentro do verão
    // dão a mesma resposta — a causa é a fronteira da época, não o DST.
    for (let weekday = 0; weekday < 7; weekday++) {
      const c = contract({ frequency: "biweekly", weekdays: [weekday], startsOn: "2026-01-05" });
      const inverno = compareContract(c, { start: "2026-01-05", end: "2026-03-20" }).changed;
      const verao = compareContract(c, { start: "2026-06-01", end: "2026-09-30" }).changed;
      expect(verao).toBe(inverno);
    }
  });

  it("a razão registada é sempre WEEK_ANCHOR nestas frequências", () => {
    const diff = compareContract(
      contract({ frequency: "biweekly", weekdays: [4], startsOn: "2026-01-05" }),
      { start: "2026-01-05", end: "2026-12-31" },
    );
    expect(diff.changed).toBe(true);
    expect(diff.reasons).toEqual(["WEEK_ANCHOR"]);
  });
});

// ─── mensal ─────────────────────────────────────────────────────────────────

describe("matriz de mudança: mensal", () => {
  it("qualquer mensal muda numa janela de vários meses", () => {
    // O antigo só gerava no primeiro mês; o canónico gera em todos.
    for (const dia of [1, 15, 28, 29, 30, 31]) {
      const startsOn = `2026-01-${String(dia).padStart(2, "0")}`;
      const diff = compareContract(
        contract({ frequency: "monthly", startsOn }),
        { start: "2026-01-01", end: "2026-06-30" },
      );
      expect(diff.changed, `dia ${dia}`).toBe(true);
      expect(diff.reasons).toContain("MONTHLY_MULTI_MONTH");
      expect(diff.removed, `dia ${dia}: nada é perdido`).toEqual([]);
    }
  });

  it("dias 29/30/31 assinalam também o clamp", () => {
    for (const dia of [29, 30, 31]) {
      const diff = compareContract(
        contract({ frequency: "monthly", startsOn: `2026-01-${dia}` }),
        { start: "2026-01-01", end: "2026-06-30" },
      );
      expect(diff.reasons).toContain("MONTHLY_CLAMP");
    }
  });

  it("num único mês, o mensal comum não muda", () => {
    const diff = compareContract(
      contract({ frequency: "monthly", startsOn: "2026-01-15" }),
      { start: "2026-03-01", end: "2026-03-31" },
    );
    expect(diff.changed).toBe(false);
  });
});

// ─── frequências que não devem mudar ────────────────────────────────────────

describe("frequências que não devem mudar", () => {
  it.each([
    ["daily", null, 1],
    ["weekly", [1], 1],
    ["weekly", [1, 3, 5], 1],
    ["weekly", [0], 1],
    ["weekly", [6], 1],
    ["custom", null, 3],
    ["custom", null, 7],
    ["custom", null, 45],
  ])("%s (weekdays=%s, intervalo=%i) mantém-se igual", (frequency, weekdays, intervalDays) => {
    const c = contract({
      frequency,
      weekdays: weekdays as number[] | null,
      intervalDays: intervalDays as number,
      startsOn: "2026-01-05",
    });
    expect(compareContract(c, ANO_2026).changed).toBe(false);
    expect(ruleChanges(c)).toBe(false);
  });

  it("custom com contrato antigo também se mantém", () => {
    const c = contract({ frequency: "custom", intervalDays: 10, startsOn: "2020-03-02" });
    expect(compareContract(c, { start: "2026-08-01", end: "2026-08-31" }).changed).toBe(false);
  });
});

// ─── resumo agregado ────────────────────────────────────────────────────────

describe("compareContracts — resumo", () => {
  it("conta por frequência, por razão, e não altera a entrada", () => {
    const contratos: CompatContract[] = [
      contract({ id: "a", frequency: "weekly", weekdays: [1] }),
      contract({ id: "b", frequency: "biweekly", weekdays: [4] }), // muda
      contract({ id: "c", frequency: "biweekly", weekdays: [1] }), // não muda
      contract({ id: "d", frequency: "triweekly", weekdays: [5] }), // muda
      contract({ id: "e", frequency: "monthly", startsOn: "2026-01-31" }), // muda
      contract({ id: "f", frequency: "custom", intervalDays: 5 }),
    ];
    const congelado = JSON.stringify(contratos);

    const report = compareContracts(contratos, { start: "2026-01-01", end: "2026-06-30" });

    expect(report.summary.totalContracts).toBe(6);
    expect(report.summary.changed).toBe(3);
    expect(report.summary.unchanged).toBe(3);
    expect(report.summary.biweeklyChanged).toBe(1);
    expect(report.summary.triweeklyChanged).toBe(1);
    expect(report.summary.monthlyChanged).toBe(1);
    expect(report.summary.weeklyChanged).toBe(0);
    expect(report.summary.customChanged).toBe(0);
    expect(report.summary.byReason.WEEK_ANCHOR).toBe(2);
    expect(report.summary.byReason.UNEXPECTED).toBe(0);

    expect(JSON.stringify(contratos)).toBe(congelado);
  });

  it("é determinístico", () => {
    const contratos = [contract({ id: "a", frequency: "biweekly", weekdays: [4] })];
    expect(compareContracts(contratos, ANO_2026)).toEqual(compareContracts(contratos, ANO_2026));
  });

  it("regra inválida é contada e não gera diferenças", () => {
    const report = compareContracts(
      [contract({ id: "x", frequency: "weekly", weekdays: [1], startsOn: "72026-01-01" })],
      ANO_2026,
    );
    expect(report.summary.invalidRules).toBe(1);
    expect(report.summary.changed).toBe(0);
  });

  it("added e removed identificam as datas concretas", () => {
    const diff = compareContract(
      contract({ id: "z", frequency: "biweekly", weekdays: [4], startsOn: "2026-01-05" }),
      { start: "2026-01-05", end: "2026-02-15" },
    );
    // As duas listas têm de ser disjuntas e explicar a diferença toda.
    expect(diff.added.some((d) => diff.removed.includes(d))).toBe(false);
    expect(diff.differenceCount).toBe(diff.added.length + diff.removed.length);
    expect(diff.canonical).toEqual(
      [...diff.legacy.filter((d) => !diff.removed.includes(d)), ...diff.added].sort(),
    );
  });
});
