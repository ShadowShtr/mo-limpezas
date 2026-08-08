// T14 — Absentismo dentro do período.
//
// O defeito medido: `src/app/actions/reports.ts` conta a duração INTEIRA de
// cada ausência, mesmo quando só parte dela cai no mês do relatório. Uma baixa
// de 61 dias aparece com 61 dias em agosto (que tem 31) e outra vez em
// setembro. O KPI "Dias de falta" da página soma exactamente essa coluna.

import { describe, it, expect } from "vitest";
import {
  absenceDaysByCollaborator,
  absenceDaysByType,
  absenceDaysWithinPeriod,
  absenceHoursWithinPeriod,
  summariseAbsences,
  totalAbsenceDays,
} from "@/domain/reports/absence-metrics";
import { legacyTotalAbsenceDays } from "@/domain/reports/legacy-reports";
import { monthPeriod, periodDays } from "@/domain/reports/period";
import type { AbsenceInput } from "@/domain/reports/report-sources";

const AGOSTO = monthPeriod(2026, 8)!;
const SETEMBRO = monthPeriod(2026, 9)!;

function abs(over: Partial<AbsenceInput> = {}): AbsenceInput {
  return {
    id: "a1",
    collaboratorId: "c1",
    type: "doenca_com_baixa",
    startsOn: "2026-08-10",
    endsOn: "2026-08-12",
    ...over,
  };
}

describe("absenceDaysWithinPeriod", () => {
  it("ausência inteiramente dentro conta por inteiro", () => {
    expect(absenceDaysWithinPeriod(abs(), AGOSTO)).toBe(3);
  });

  it("ausência de um dia conta 1", () => {
    expect(absenceDaysWithinPeriod(abs({ startsOn: "2026-08-10", endsOn: "2026-08-10" }), AGOSTO)).toBe(1);
  });

  it("ausência que começa antes conta só a parte de dentro", () => {
    const a = abs({ startsOn: "2026-07-20", endsOn: "2026-08-05" });
    expect(absenceDaysWithinPeriod(a, AGOSTO)).toBe(5);
  });

  it("ausência que termina depois conta só a parte de dentro", () => {
    const a = abs({ startsOn: "2026-08-25", endsOn: "2026-09-10" });
    expect(absenceDaysWithinPeriod(a, AGOSTO)).toBe(7);
  });

  it("ausência que cobre o período inteiro conta os dias do período", () => {
    const a = abs({ startsOn: "2026-01-01", endsOn: "2026-12-31" });
    expect(absenceDaysWithinPeriod(a, AGOSTO)).toBe(31);
  });

  it("ausência fora do período conta zero", () => {
    expect(absenceDaysWithinPeriod(abs({ startsOn: "2026-05-01", endsOn: "2026-05-03" }), AGOSTO)).toBe(0);
  });

  it("devolve null — e não zero — quando o intervalo é inválido", () => {
    // Zero seria indistinguível de "não tocou o período".
    expect(absenceDaysWithinPeriod(abs({ startsOn: "2026-08-20", endsOn: "2026-08-10" }), AGOSTO)).toBeNull();
    expect(absenceDaysWithinPeriod(abs({ startsOn: "72026-08-01" }), AGOSTO)).toBeNull();
  });
});

describe("a soma sobre meses fecha na duração real", () => {
  it("não conta a ausência duas vezes", () => {
    const baixa = abs({ startsOn: "2026-08-01", endsOn: "2026-09-30" });
    const agosto = absenceDaysWithinPeriod(baixa, AGOSTO)!;
    const setembro = absenceDaysWithinPeriod(baixa, SETEMBRO)!;

    expect(agosto).toBe(31);
    expect(setembro).toBe(30);
    expect(agosto + setembro).toBe(61);

    // O que o código actual faz: 61 em cada mês, 122 no total.
    expect(legacyTotalAbsenceDays([baixa])).toBe(61);
    expect(legacyTotalAbsenceDays([baixa]) * 2).toBe(122);
  });

  it("o total do mês nunca excede o máximo possível", () => {
    // Invariante: nenhum colaborador pode faltar mais dias do que o mês tem.
    const baixa = abs({ startsOn: "2026-06-01", endsOn: "2026-12-31" });
    const { contributions } = summariseAbsences([baixa], AGOSTO);
    expect(totalAbsenceDays(contributions)).toBeLessThanOrEqual(periodDays(AGOSTO));

    // O número antigo é impossível: 214 dias de falta num mês de 31.
    expect(legacyTotalAbsenceDays([baixa])).toBeGreaterThan(periodDays(AGOSTO));
  });
});

describe("absenceHoursWithinPeriod", () => {
  it("devolve null sem jornada declarada — não inventa 8 h/dia", () => {
    // O schema não define nenhuma jornada diária. Inventá-la faria o
    // absentismo em horas parecer um facto quando seria um palpite.
    expect(absenceHoursWithinPeriod(abs(), AGOSTO, null)).toBeNull();
  });

  it("converte quando a jornada é passada explicitamente", () => {
    expect(absenceHoursWithinPeriod(abs(), AGOSTO, 8)).toBe(24);
  });

  it("recusa jornadas absurdas em vez de as usar", () => {
    expect(absenceHoursWithinPeriod(abs(), AGOSTO, -1)).toBeNull();
    expect(absenceHoursWithinPeriod(abs(), AGOSTO, Number.NaN)).toBeNull();
  });

  it("propaga o null de um intervalo inválido", () => {
    expect(absenceHoursWithinPeriod(abs({ endsOn: "2026-08-01" }), AGOSTO, 8)).toBeNull();
  });
});

describe("summariseAbsences", () => {
  it("marca como truncada a ausência que transborda", () => {
    const { contributions } = summariseAbsences(
      [abs({ startsOn: "2026-07-20", endsOn: "2026-08-05" })],
      AGOSTO,
    );
    expect(contributions[0].truncated).toBe(true);
    expect(contributions[0].daysWithinPeriod).toBe(5);
    expect(contributions[0].totalDays).toBe(17);
  });

  it("não marca como truncada a que cabe inteira", () => {
    const { contributions } = summariseAbsences([abs()], AGOSTO);
    expect(contributions[0].truncated).toBe(false);
  });

  it("regista INVALID_DATE_RANGE e exclui a linha", () => {
    const { contributions, issues } = summariseAbsences(
      [abs({ startsOn: "2026-08-20", endsOn: "2026-08-10" })],
      AGOSTO,
    );
    expect(contributions).toHaveLength(0);
    expect(issues.map((i) => i.code)).toContain("INVALID_DATE_RANGE");
  });

  it("regista UNKNOWN_STATUS para um tipo fora do CHECK do schema", () => {
    const { issues } = summariseAbsences([abs({ type: "inventado" })], AGOSTO);
    expect(issues.map((i) => i.code)).toContain("UNKNOWN_STATUS");
  });

  it("regista RECORD_OUTSIDE_PERIOD sem rebentar o relatório", () => {
    const { contributions, issues } = summariseAbsences(
      [abs({ startsOn: "2026-05-01", endsOn: "2026-05-02" })],
      AGOSTO,
    );
    expect(issues.map((i) => i.code)).toContain("RECORD_OUTSIDE_PERIOD");
    expect(totalAbsenceDays(contributions)).toBe(0);
  });

  it("descarta ausências repetidas em vez de as somar duas vezes", () => {
    const { contributions, issues } = summariseAbsences([abs(), abs()], AGOSTO);
    expect(contributions).toHaveLength(1);
    expect(issues.map((i) => i.code)).toContain("DUPLICATE_SERVICE_ID");
  });

  it("nunca expõe dados pessoais no problema registado", () => {
    const { issues } = summariseAbsences([abs({ type: "inventado" })], AGOSTO);
    for (const i of issues) {
      expect(i.subject).toBe("a1"); // só o id técnico
    }
  });
});

describe("agrupamentos", () => {
  const absences: AbsenceInput[] = [
    abs({ id: "a1", collaboratorId: "c1", type: "ferias", startsOn: "2026-08-01", endsOn: "2026-08-10" }),
    abs({ id: "a2", collaboratorId: "c1", type: "doenca_com_baixa", startsOn: "2026-07-28", endsOn: "2026-08-02" }),
    abs({ id: "a3", collaboratorId: "c2", type: "ferias", startsOn: "2026-08-20", endsOn: "2026-09-05" }),
  ];
  const { contributions } = summariseAbsences(absences, AGOSTO);

  it("soma por tipo apenas os dias dentro do período", () => {
    expect(absenceDaysByType(contributions)).toEqual({
      ferias: 10 + 12,
      doenca_com_baixa: 2,
    });
  });

  it("soma por colaborador apenas os dias dentro do período", () => {
    expect(absenceDaysByCollaborator(contributions)).toEqual({ c1: 12, c2: 12 });
  });

  it("o total bate com a soma dos agrupamentos", () => {
    const porTipo = Object.values(absenceDaysByType(contributions)).reduce((a, b) => a + b, 0);
    const porPessoa = Object.values(absenceDaysByCollaborator(contributions)).reduce((a, b) => a + b, 0);
    expect(totalAbsenceDays(contributions)).toBe(porTipo);
    expect(totalAbsenceDays(contributions)).toBe(porPessoa);
  });
});
