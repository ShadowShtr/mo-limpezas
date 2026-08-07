// ============================================================================
// T11 — Fronteiras entre módulos de valor
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Nenhum teste aqui altera runtime. Fixam o que HOJE é verdade, incluindo uma
// divergência que a T11 encontrou e deliberadamente NÃO corrigiu.
//
// Existem três sítios a decidir "quanto vale isto":
//
//   src/lib/service-value.ts                    calculateServiceValue  (UI + actions)
//   src/domain/scheduling/occurrence-projection projectValue           (T09, cron)
//   src/domain/billing/*                        T11                    (agregação)
//
// A fronteira que a T11 fixa:
//
//   T09  decide o valor de UMA ocorrência a partir do contrato.
//   T11  agrega, distribui e classifica valores JÁ decididos.
//
// A T11 nunca recalcula scheduling e nunca inventa um terceiro valor de serviço.

import { describe, it, expect } from "vitest";
import { calculateServiceValue, withVat } from "@/lib/service-value";
import {
  projectValue,
  upholsteryTotal,
  type ContractProjectionFields,
} from "@/domain/scheduling/occurrence-projection";
import { applyVat } from "@/domain/billing/vat";
import { eurosToCents } from "@/domain/billing/money";
import type { ScheduleDay } from "@/types/database";

const schedule: ScheduleDay = {
  day: "mon",
  start_time: "09:00",
  duration_min: 120,
  team_id: null,
};

function contract(over: Partial<ContractProjectionFields> = {}): ContractProjectionFields {
  return {
    fixedMonthly: false,
    fixedPrice: null,
    hourlyRate: null,
    upholsteryType: null,
    upholsteryNotes: null,
    upholsteryUnits: null,
    upholsteryUnitPrice: null,
    ...over,
  } as ContractProjectionFields;
}

describe("avença: o serviço vale 0, o contrato vale o mês", () => {
  it("as duas fontes concordam que a ocorrência vale 0", () => {
    expect(projectValue(contract({ fixedMonthly: true, fixedPrice: 300 }), schedule, 1)).toBe(0);
    expect(
      calculateServiceValue({
        durationMin: 120, hourlyRate: 12, numPeople: 1, manualValue: null,
        fixedMonthly: true, contractFixedPrice: 300,
        upholsteryUnits: null, upholsteryUnitPrice: null,
      }),
    ).toBe(0);
  });

  it("é por isso que a avença precisa da alocação da T11", () => {
    // Somar `calculated_value` dos serviços de uma avença dá sempre 0. O valor
    // do mês só existe no contrato, e distribuí-lo é trabalho do T11.
    const ocorrencias = [0, 0, 0];
    expect(ocorrencias.reduce((a, b) => a + b, 0)).toBe(0);
    expect(eurosToCents(300)).toBe(30000);
  });
});

describe("estofos: units × unit_price, e nada mais", () => {
  it("a regra da T09 mantém-se — a T11 não cria outra fórmula", () => {
    const c = contract({ upholsteryUnits: 3, upholsteryUnitPrice: 25.5 });
    expect(upholsteryTotal(c)).toBe(76.5);
    expect(projectValue(c, schedule, 1)).toBe(76.5);
  });

  it("unidades ou preço em falta dão null, não zero", () => {
    expect(upholsteryTotal(contract({ upholsteryUnits: 3, upholsteryUnitPrice: null }))).toBeNull();
    expect(upholsteryTotal(contract({ upholsteryUnits: null, upholsteryUnitPrice: 25 }))).toBeNull();
    expect(upholsteryTotal(contract({ upholsteryUnits: 0, upholsteryUnitPrice: 25 }))).toBeNull();
  });

  it("não existe `unit_value` — o campo que só vivia no formulário", () => {
    const c = contract({ upholsteryUnits: 4, upholsteryUnitPrice: 10 });
    expect(c).not.toHaveProperty("unitValue");
    expect(upholsteryTotal(c)).toBe(40);
  });
});

describe("DIVERGÊNCIA CONHECIDA — prioridade entre preço fixo e estofos", () => {
  // Encontrada pela auditoria da T11 e NÃO corrigida aqui de propósito:
  // qualquer das duas correcções muda valores de serviços reais, e a T11 é
  // offline. Fica medida, com teste, para o Financeiro V2 decidir.
  //
  //   calculateServiceValue  →  estofos ANTES de fixedPrice
  //   projectValue (T09)     →  fixedPrice ANTES de estofos
  //
  // Um contrato com os dois campos preenchidos vale coisas diferentes conforme
  // o caminho: a UI mostra o total dos estofos, o cron grava o preço fixo.
  const ambos = {
    fixedMonthly: false,
    fixedPrice: 200,
    upholsteryUnits: 3,
    upholsteryUnitPrice: 25,
  };

  it("as duas funções divergem hoje, e o teste prova-o", () => {
    const viaUi = calculateServiceValue({
      durationMin: 120, hourlyRate: null, numPeople: 1, manualValue: null,
      fixedMonthly: false, contractFixedPrice: ambos.fixedPrice,
      upholsteryUnits: ambos.upholsteryUnits, upholsteryUnitPrice: ambos.upholsteryUnitPrice,
    });
    const viaCron = projectValue(contract(ambos), schedule, 1);

    expect(viaUi).toBe(75);   // 3 × 25
    expect(viaCron).toBe(200); // preço fixo
    expect(viaUi).not.toBe(viaCron);
  });

  it("sem conflito de campos, as duas concordam", () => {
    const soFixo = { fixedMonthly: false, fixedPrice: 200 };
    expect(
      calculateServiceValue({
        durationMin: 120, hourlyRate: null, numPeople: 1, manualValue: null,
        fixedMonthly: false, contractFixedPrice: 200,
        upholsteryUnits: null, upholsteryUnitPrice: null,
      }),
    ).toBe(200);
    expect(projectValue(contract(soFixo), schedule, 1)).toBe(200);
  });

  it("por hora, as duas concordam", () => {
    expect(
      calculateServiceValue({
        durationMin: 120, hourlyRate: 12, numPeople: 2, manualValue: null,
        fixedMonthly: false, contractFixedPrice: null,
        upholsteryUnits: null, upholsteryUnitPrice: null,
      }),
    ).toBe(48);
    expect(projectValue(contract({ hourlyRate: 12 }), schedule, 2)).toBe(48);
  });
});

describe("manual_value continua a mandar", () => {
  it("nunca é recalculado por cima", () => {
    expect(
      calculateServiceValue({
        durationMin: 120, hourlyRate: 12, numPeople: 3, manualValue: 42.5,
        fixedMonthly: true, contractFixedPrice: 300,
        upholsteryUnits: 5, upholsteryUnitPrice: 10,
      }),
    ).toBe(42.5);
  });
});

describe("sem base de cálculo dá null, nunca zero", () => {
  it("as duas fontes preservam a distinção da T09", () => {
    expect(projectValue(contract(), schedule, 1)).toBeNull();
    expect(
      calculateServiceValue({
        durationMin: 0, hourlyRate: null, numPeople: null, manualValue: null,
        fixedMonthly: false, contractFixedPrice: null,
        upholsteryUnits: null, upholsteryUnitPrice: null,
      }),
    ).toBeNull();
  });
});

describe("o IVA canónico é compatível com o withVat existente", () => {
  it("num valor isolado dá o mesmo total", () => {
    for (const base of [10, 76.5, 99.99, 200]) {
      expect(eurosToCents(withVat(base, true, 23))).toBe(
        applyVat(eurosToCents(base)!, { applyVat: true, ratePct: 23 }).grossCents,
      );
    }
  });

  it("sem IVA nenhum dos dois altera a base", () => {
    expect(withVat(100, false, 23)).toBe(100);
    expect(applyVat(eurosToCents(100)!, { applyVat: false, ratePct: 23 }).grossCents).toBe(10000);
  });
});
