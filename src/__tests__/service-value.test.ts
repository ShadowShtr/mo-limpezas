import { describe, expect, it } from "vitest";
import { calculateServiceValue, withVat } from "@/lib/service-value";

// Cobre a fonte única de valor de um serviço (reschedule, painel de detalhe,
// reescrita de contrato, cards do calendário e ficha do cliente usam isto).

describe("withVat", () => {
  it("devolve o valor base quando apply_vat é false", () => {
    expect(withVat(60, false, 23)).toBe(60);
  });

  it("soma o IVA quando apply_vat é true", () => {
    expect(withVat(60, true, 23)).toBeCloseTo(73.8, 2);
  });

  it("arredonda a 2 casas decimais", () => {
    expect(withVat(33.33, true, 23)).toBeCloseTo(41.0, 2);
  });

  it("é o mesmo cálculo em qualquer taxa de IVA configurada", () => {
    expect(withVat(100, true, 6)).toBeCloseTo(106, 2);
    expect(withVat(100, true, 13)).toBeCloseTo(113, 2);
  });
});

describe("calculateServiceValue — prioridades", () => {
  const base = {
    durationMin: 120,
    hourlyRate: 10,
    numPeople: 2,
    manualValue: null,
    fixedMonthly: false,
    contractFixedPrice: null,
    upholsteryUnits: null,
    upholsteryUnitPrice: null,
  };

  it("1. valor manual tem sempre prioridade", () => {
    expect(calculateServiceValue({ ...base, manualValue: 999 })).toBe(999);
  });

  it("2. estofos (units × preço) acima de avença/fixo/hora", () => {
    expect(calculateServiceValue({ ...base, upholsteryUnits: 3, upholsteryUnitPrice: 5, fixedMonthly: true, contractFixedPrice: 50 })).toBe(15);
  });

  it("3. avença mensal → serviço vale 0", () => {
    expect(calculateServiceValue({ ...base, fixedMonthly: true, contractFixedPrice: 50 })).toBe(0);
  });

  it("4. valor fixo por serviço acima do cálculo por hora", () => {
    expect(calculateServiceValue({ ...base, contractFixedPrice: 42 })).toBe(42);
  });

  it("5. por hora: duração × taxa × pessoas", () => {
    expect(calculateServiceValue(base)).toBe(40); // 2h × 10 × 2
  });

  it("sem hourly_rate nem nenhuma outra regra → null", () => {
    expect(calculateServiceValue({ ...base, hourlyRate: null })).toBeNull();
  });
});
