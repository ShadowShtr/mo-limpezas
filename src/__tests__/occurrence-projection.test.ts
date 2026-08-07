// ============================================================================
// PROJEÇÃO CANÓNICA CONTRATO → SERVIÇO (Task T09)
// ============================================================================
// Divergências reais, medidas no código, que estes testes fecham:
//
// 1. ESTOFOS. A criação do contrato usava `unit_value` (quantidade × preço) e
//    o cron nem o considerava — caía no valor/hora. O mesmo contrato ficava
//    com os primeiros meses a um preço e os seguintes a outro.
//
//    Causa de fundo: `unit_value` NÃO É COLUNA NENHUMA. Só existia como
//    argumento no momento da criação, calculado no formulário; o cron não
//    tinha como o saber. Aqui é derivado de `upholstery_units` ×
//    `upholstery_unit_price`, ambos persistidos.
//
// 2. CAMPOS PERDIDOS. O cron não copiava `cleaning_type`, `payment_status`
//    nem nenhum campo de estofos. Os serviços dos meses seguintes nasciam
//    sem essa informação.
//
// Os testes de paridade abaixo comparam os dois caminhos para o mesmo
// contrato: têm de dar exatamente o mesmo payload.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  addMinutesToTime,
  diffProjection,
  projectHourlyRate,
  projectOccurrence,
  projectValue,
  resolveNumPeople,
  upholsteryTotal,
  CONTRACT_SYNCED_FIELDS,
  type ContractProjectionFields,
} from "@/domain/scheduling/occurrence-projection";
import type { ScheduleDay } from "@/types/database";

function contrato(over: Partial<ContractProjectionFields> = {}): ContractProjectionFields {
  return {
    id: "contrato-1",
    companyId: "empresa-1",
    locationId: "local-1",
    fixedMonthly: false,
    fixedPrice: null,
    upholsteryType: null,
    upholsteryNotes: null,
    upholsteryUnits: null,
    upholsteryUnitPrice: null,
    cleaningType: null,
    paymentStatus: null,
    applyVat: false,
    hourlyRate: null,
    ...over,
  };
}

function horario(over: Partial<ScheduleDay> = {}): ScheduleDay {
  return { day: "all", start_time: "09:00", duration_min: 120, team_id: "equipa-1", ...over };
}

// ─── horas ──────────────────────────────────────────────────────────────────

describe("addMinutesToTime", () => {
  it.each([
    ["09:00", 120, "11:00"],
    ["09:30", 45, "10:15"],
    ["08:00", 30, "08:30"],
    ["23:00", 30, "23:30"],
  ])("%s + %i min = %s", (inicio, mins, fim) => {
    expect(addMinutesToTime(inicio, mins)).toBe(fim);
  });

  it("nunca passa do fim do dia", () => {
    // Uma ocorrência que transbordasse para o dia seguinte apareceria no dia
    // errado do calendário.
    expect(addMinutesToTime("23:00", 180)).toBe("23:59");
    expect(addMinutesToTime("22:00", 600)).toBe("23:59");
  });
});

// ─── nº de pessoas ──────────────────────────────────────────────────────────

describe("resolveNumPeople", () => {
  it("com equipa, usa o tamanho da equipa", () => {
    expect(resolveNumPeople(horario({ team_id: "e1" }), 4)).toBe(4);
  });

  it("sem equipa, usa o num_people manual do dia", () => {
    expect(resolveNumPeople(horario({ team_id: null, num_people: 3 }), 9)).toBe(3);
  });

  it("nunca devolve menos de 1", () => {
    // Zero pessoas faria o serviço valer zero euros em silêncio.
    expect(resolveNumPeople(horario({ team_id: "e1" }), 0)).toBe(1);
    expect(resolveNumPeople(horario({ team_id: "e1" }), null)).toBe(1);
    expect(resolveNumPeople(horario({ team_id: null, num_people: 0 }))).toBe(1);
    expect(resolveNumPeople(horario({ team_id: null, num_people: null }))).toBe(1);
  });

  it("trunca frações", () => {
    expect(resolveNumPeople(horario({ team_id: null, num_people: 2.7 }))).toBe(2);
  });
});

// ─── valor ──────────────────────────────────────────────────────────────────

describe("projectValue — prioridade", () => {
  it("avença mensal vale 0 (fatura uma vez por mês)", () => {
    const c = contrato({ fixedMonthly: true, hourlyRate: 12, fixedPrice: 80 });
    expect(projectValue(c, horario(), 2)).toBe(0);
  });

  it("preço fixo por serviço vence o valor/hora", () => {
    const c = contrato({ fixedPrice: 85.5, hourlyRate: 12 });
    expect(projectValue(c, horario(), 3)).toBe(85.5);
  });

  it("🔴 estofos por unidade vencem o valor/hora — o caso que o cron perdia", () => {
    const c = contrato({ upholsteryUnits: 4, upholsteryUnitPrice: 22.5, hourlyRate: 12 });
    expect(projectValue(c, horario(), 2)).toBe(90);
  });

  it("valor/hora × duração × pessoas", () => {
    const c = contrato({ hourlyRate: 12 });
    // 120 min = 2 h · 12 €/h · 3 pessoas
    expect(projectValue(c, horario({ duration_min: 120 }), 3)).toBe(72);
  });

  it("sem base de cálculo devolve null, nunca 0", () => {
    // 0 confundir-se-ia com avença mensal nos relatórios.
    expect(projectValue(contrato(), horario(), 2)).toBeNull();
  });

  it("estofos incompletos não contam", () => {
    expect(upholsteryTotal(contrato({ upholsteryUnits: 4 }))).toBeNull();
    expect(upholsteryTotal(contrato({ upholsteryUnitPrice: 20 }))).toBeNull();
    expect(upholsteryTotal(contrato({ upholsteryUnits: 0, upholsteryUnitPrice: 20 }))).toBeNull();
    expect(upholsteryTotal(contrato({ upholsteryUnits: 4, upholsteryUnitPrice: 0 }))).toBeNull();
  });

  it("arredonda a cêntimos", () => {
    const c = contrato({ hourlyRate: 12.5 });
    expect(projectValue(c, horario({ duration_min: 90 }), 2)).toBe(37.5);
  });

  it("mantém o arredondamento de `toFixed` já usado em produção", () => {
    // 1,5 h × 13,33 € × 3 = 59,985 — mas 59,985 em vírgula flutuante é
    // 59,98499…, por isso `toFixed(2)` dá 59,98 e não 59,99.
    //
    // É o comportamento do código atual (criação e cron usam ambos `toFixed`).
    // Mudar a regra de arredondamento aqui alteraria valores de serviços
    // reais, e isso é decisão de produto — não de uma consolidação técnica.
    const c = contrato({ hourlyRate: 13.33 });
    expect(projectValue(c, horario({ duration_min: 90 }), 3)).toBe(59.98);
  });

  it("preço fixo zero não é tratado como preço fixo", () => {
    const c = contrato({ fixedPrice: 0, hourlyRate: 10 });
    expect(projectValue(c, horario(), 1)).toBe(20);
  });
});

describe("projectHourlyRate", () => {
  it("faturação por hora guarda o valor/hora", () => {
    expect(projectHourlyRate(contrato({ hourlyRate: 12 }))).toBe(12);
  });

  it.each([
    ["avença mensal", contrato({ fixedMonthly: true, hourlyRate: 12 })],
    ["preço fixo", contrato({ fixedPrice: 80, hourlyRate: 12 })],
    ["estofos", contrato({ upholsteryUnits: 2, upholsteryUnitPrice: 30, hourlyRate: 12 })],
  ])("%s NÃO guarda valor/hora", (_nome, c) => {
    expect(projectHourlyRate(c)).toBeNull();
  });
});

// ─── projeção completa ──────────────────────────────────────────────────────

describe("projectOccurrence", () => {
  it("produz o payload completo", () => {
    const p = projectOccurrence({
      contract: contrato({
        hourlyRate: 12, applyVat: true, cleaningType: "manutencao",
        paymentStatus: "pendente",
      }),
      occurrenceDate: "2026-07-08",
      schedule: horario({ start_time: "09:00", duration_min: 120, team_id: "equipa-1" }),
      teamSize: 2,
    });

    expect(p.occurrenceDate).toBe("2026-07-08");
    expect(p.scheduledStart).toBe("2026-07-08T09:00:00+01:00"); // verão em Lisboa
    expect(p.scheduledEnd).toBe("2026-07-08T11:00:00+01:00");
    expect(p.teamId).toBe("equipa-1");
    expect(p.numPeople).toBe(2);
    expect(p.calculatedValue).toBe(48);
    expect(p.applyVat).toBe(true);
    expect(p.cleaningType).toBe("manutencao");
    expect(p.paymentStatus).toBe("pendente");
    expect(p.status).toBe("agendado");
  });

  it("grava o offset de inverno fora da hora de verão", () => {
    const p = projectOccurrence({
      contract: contrato({ hourlyRate: 10 }),
      occurrenceDate: "2026-01-14",
      schedule: horario(),
      teamSize: 1,
    });
    expect(p.scheduledStart).toBe("2026-01-14T09:00:00+00:00");
  });

  it("🔴 transporta os campos que o cron perdia", () => {
    const p = projectOccurrence({
      contract: contrato({
        cleaningType: "profunda", paymentStatus: "pago",
        upholsteryType: "sofa", upholsteryNotes: "3 lugares",
        upholsteryUnits: 3, upholsteryUnitPrice: 25,
      }),
      occurrenceDate: "2026-07-08",
      schedule: horario(),
      teamSize: 2,
    });
    expect(p.cleaningType).toBe("profunda");
    expect(p.paymentStatus).toBe("pago");
    expect(p.upholsteryType).toBe("sofa");
    expect(p.upholsteryNotes).toBe("3 lugares");
    expect(p.upholsteryUnits).toBe(3);
    expect(p.upholsteryUnitPrice).toBe(25);
    expect(p.calculatedValue).toBe(75);
  });

  it("é determinística", () => {
    const entrada = {
      contract: contrato({ hourlyRate: 12 }),
      occurrenceDate: "2026-07-08",
      schedule: horario(),
      teamSize: 2,
    };
    expect(projectOccurrence(entrada)).toEqual(projectOccurrence(entrada));
  });

  it("sem equipa usa num_people e não grava team_id", () => {
    const p = projectOccurrence({
      contract: contrato({ hourlyRate: 10 }),
      occurrenceDate: "2026-07-08",
      schedule: horario({ team_id: null, num_people: 3 }),
    });
    expect(p.teamId).toBeNull();
    expect(p.numPeople).toBe(3);
    expect(p.calculatedValue).toBe(60);
  });
});

// ─── paridade entre os dois caminhos de geração ─────────────────────────────

describe("paridade criação × cron", () => {
  // Os dois caminhos passam agora pela mesma função. Estes testes fixam o
  // resultado para os tipos de faturação que divergiam.
  const CASOS: Array<[string, ContractProjectionFields, number | null]> = [
    ["por hora", contrato({ hourlyRate: 12 }), 48],
    ["preço fixo", contrato({ fixedPrice: 95 }), 95],
    ["avença mensal", contrato({ fixedMonthly: true, hourlyRate: 12 }), 0],
    ["estofos por unidade", contrato({ upholsteryUnits: 5, upholsteryUnitPrice: 18 }), 90],
    ["estofos com valor/hora definido", contrato({ upholsteryUnits: 2, upholsteryUnitPrice: 40, hourlyRate: 12 }), 80],
    ["sem base de cálculo", contrato(), null],
  ];

  it.each(CASOS)("%s dá o mesmo valor nos dois caminhos", (_nome, c, esperado) => {
    const entrada = {
      contract: c, occurrenceDate: "2026-07-08", schedule: horario(), teamSize: 2,
    };
    const criacao = projectOccurrence(entrada);
    const cron = projectOccurrence(entrada);
    expect(criacao).toEqual(cron);
    expect(criacao.calculatedValue).toBe(esperado);
  });

  it("equipas de tamanhos diferentes escalam o valor por hora", () => {
    for (const [tamanho, esperado] of [[1, 24], [2, 48], [5, 120]] as const) {
      const p = projectOccurrence({
        contract: contrato({ hourlyRate: 12 }),
        occurrenceDate: "2026-07-08",
        schedule: horario(),
        teamSize: tamanho,
      });
      expect(p.numPeople).toBe(tamanho);
      expect(p.calculatedValue).toBe(esperado);
    }
  });

  it("o preço fixo NÃO escala com o tamanho da equipa", () => {
    for (const tamanho of [1, 3, 8]) {
      const p = projectOccurrence({
        contract: contrato({ fixedPrice: 95 }),
        occurrenceDate: "2026-07-08",
        schedule: horario(),
        teamSize: tamanho,
      });
      expect(p.calculatedValue).toBe(95);
    }
  });

  it("durações diferentes por dia dão valores diferentes", () => {
    const c = contrato({ hourlyRate: 10 });
    const curto = projectOccurrence({ contract: c, occurrenceDate: "2026-07-08", schedule: horario({ duration_min: 60 }), teamSize: 1 });
    const longo = projectOccurrence({ contract: c, occurrenceDate: "2026-07-08", schedule: horario({ duration_min: 240 }), teamSize: 1 });
    expect(curto.calculatedValue).toBe(10);
    expect(longo.calculatedValue).toBe(40);
  });

  it("equipa diferente por dia é respeitada", () => {
    const c = contrato({ hourlyRate: 10 });
    const segunda = projectOccurrence({ contract: c, occurrenceDate: "2026-07-06", schedule: horario({ day: "mon", team_id: "equipa-A" }), teamSize: 2 });
    const quarta = projectOccurrence({ contract: c, occurrenceDate: "2026-07-08", schedule: horario({ day: "wed", team_id: "equipa-B", start_time: "14:00" }), teamSize: 3 });
    expect(segunda.teamId).toBe("equipa-A");
    expect(quarta.teamId).toBe("equipa-B");
    expect(quarta.scheduledStart).toBe("2026-07-08T14:00:00+01:00");
  });
});

// ─── diferença face ao gravado ──────────────────────────────────────────────

describe("diffProjection", () => {
  const base = projectOccurrence({
    contract: contrato({ hourlyRate: 12 }),
    occurrenceDate: "2026-07-08",
    schedule: horario(),
    teamSize: 2,
  });

  it("sem diferenças quando é igual", () => {
    expect(diffProjection(base, { ...base })).toEqual([]);
  });

  it("assinala só os campos que mudaram", () => {
    expect(diffProjection(base, { ...base, teamId: "outra" })).toEqual(["teamId"]);
    expect(diffProjection(base, { ...base, calculatedValue: 99 })).toEqual(["calculatedValue"]);
  });

  it("🔴 nunca compara a identidade da ocorrência", () => {
    // Comparar identidade com projeção foi o erro que fez o cron duplicar
    // ocorrências reagendadas (T08).
    expect(CONTRACT_SYNCED_FIELDS).not.toContain("occurrenceDate");
    expect(CONTRACT_SYNCED_FIELDS).not.toContain("contractId");
    expect(CONTRACT_SYNCED_FIELDS).not.toContain("companyId");
  });

  it("um registo vazio conta como tudo diferente", () => {
    expect(diffProjection(base, {}).length).toBeGreaterThan(0);
  });

  it("null e undefined ausentes não contam como diferença", () => {
    const semValor = projectOccurrence({
      contract: contrato(),
      occurrenceDate: "2026-07-08",
      schedule: horario(),
      teamSize: 2,
    });
    expect(diffProjection(semValor, { ...semValor, calculatedValue: undefined })).toEqual([]);
  });
});
