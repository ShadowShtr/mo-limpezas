// T15 — Projeção anual.
//
// A fórmula actual divide o total do ano (que inclui o mês corrente,
// incompleto) pelo número de meses ANTERIORES com receita > 0. Numerador e
// denominador falam de conjuntos diferentes, e o resultado sobrestima sempre.
//
// Estes testes fixam o comportamento antigo e provam a diferença. **Não
// decidem** qual a projeção certa — isso é decisão de negócio (ver §17 do
// documento da T15).

import { describe, it, expect } from "vitest";
import {
  CURRENT_PROJECTION_METHOD,
  projectAnnual,
  type ProjectionInput,
} from "@/domain/dashboard/projection";
import { legacyProjectedAnnual } from "@/domain/dashboard/legacy-dashboard";
import { eurosToCents, type MoneyCents } from "@/domain/billing/money";

const cents = (v: number) => eurosToCents(v)!;

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    monthlyCents: [],
    currentMonth: 3,
    elapsedDaysInYear: 90,
    totalDaysInYear: 365,
    method: "LEGACY_AVERAGE_OF_NONZERO_MONTHS",
    ...over,
  };
}

describe("o método em uso continua a ser o legado", () => {
  it("está explicitamente apontado ao legado enquanto ninguém decidir", () => {
    // Mudar isto altera um número visível no dashboard. É decisão de produto.
    expect(CURRENT_PROJECTION_METHOD).toBe("LEGACY_AVERAGE_OF_NONZERO_MONTHS");
  });
});

describe("a réplica reproduz a fórmula actual", () => {
  // Jan 1000, Fev 1000, Mar (corrente) 200.
  const monthly = [cents(1000), cents(1000), cents(200)];

  it("bate com a implementação real, cêntimo a cêntimo", () => {
    const replica = projectAnnual(input({ monthlyCents: monthly, currentMonth: 3 }));
    const real = legacyProjectedAnnual(
      [
        { year: 2026, month: 1, revenue: 1000, costs: 0, margin: 1000 },
        { year: 2026, month: 2, revenue: 1000, costs: 0, margin: 1000 },
        { year: 2026, month: 3, revenue: 200, costs: 0, margin: 200 },
      ],
      2026, 3,
    );
    expect(replica.projectedCents).toBe(Math.round(real * 100));
  });

  it("produz uma média que nenhum mês teve", () => {
    // 2200 ÷ 2 = 1100 €/mês, quando os meses completos renderam 1000 € cada.
    const r = projectAnnual(input({ monthlyCents: monthly, currentMonth: 3 }));
    expect(r.basisCount).toBe(2);
    expect(r.projectedCents).toBe(cents(12_100));
  });

  it("exclui do denominador os meses que renderam zero", () => {
    // Jan 0, Fev 1000, Mar 0 (corrente). Média = 1000/1 = 1000, não 500.
    const r = projectAnnual(input({
      monthlyCents: [cents(0), cents(1000), cents(0)], currentMonth: 3,
    }));
    expect(r.basisCount).toBe(1);
    expect(r.projectedCents).toBe(cents(10_000));
  });

  it("sem meses anteriores com receita, devolve só o observado", () => {
    const r = projectAnnual(input({ monthlyCents: [cents(500)], currentMonth: 1 }));
    expect(r.outcome).toBe("PROJECTED");
    expect(r.projectedCents).toBe(cents(500));
    expect(r.basisCount).toBe(0);
  });

  it("o rótulo do denominador diz que os conjuntos são diferentes", () => {
    const r = projectAnnual(input({ monthlyCents: monthly, currentMonth: 3 }));
    expect(r.basisLabel).toContain("conjuntos diferentes");
  });
});

describe("LINEAR_BY_COMPLETED_MONTHS — variante canónica", () => {
  it("usa numerador e denominador do mesmo conjunto", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1000), cents(1000), cents(200)],
      currentMonth: 3,
      method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    // observado 2200 + média(1000) × 9 meses que faltam = 11 200.
    expect(r.projectedCents).toBe(cents(11_200));
    expect(r.basisCount).toBe(2);
  });

  it("inclui os meses a zero no denominador", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(0), cents(1000), cents(0)],
      currentMonth: 3,
      method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    // média(0, 1000) = 500 → 1000 + 500 × 9 = 5500.
    expect(r.basisCount).toBe(2);
    expect(r.projectedCents).toBe(cents(5_500));
  });

  it("é sempre mais conservadora ou igual à antiga quando há um mês a zero", () => {
    const monthly = [cents(0), cents(1000), cents(200)];
    const antiga = projectAnnual(input({ monthlyCents: monthly, currentMonth: 3 }));
    const nova = projectAnnual(input({
      monthlyCents: monthly, currentMonth: 3, method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    expect(nova.projectedCents!).toBeLessThan(antiga.projectedCents!);
  });

  it("em janeiro não há base para extrapolar", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(500)], currentMonth: 1, method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    expect(r.outcome).toBe("INSUFFICIENT_BASIS");
    expect(r.projectedCents).toBeNull();
    expect(r.observedCents).toBe(cents(500));
  });

  it("em dezembro não sobra nenhum mês para projectar", () => {
    const monthly = Array.from({ length: 12 }, () => cents(1000));
    const r = projectAnnual(input({
      monthlyCents: monthly, currentMonth: 12, method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    expect(r.projectedCents).toBe(cents(12_000));
  });
});

describe("LINEAR_BY_CALENDAR_DAY", () => {
  it("extrapola pelos dias civis decorridos", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1000)],
      elapsedDaysInYear: 73, // um quinto de 365
      totalDaysInYear: 365,
      method: "LINEAR_BY_CALENDAR_DAY",
    }));
    expect(r.projectedCents).toBe(cents(5_000));
  });

  it("recusa dias decorridos inválidos em vez de dividir por zero", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1000)],
      elapsedDaysInYear: 0,
      method: "LINEAR_BY_CALENDAR_DAY",
    }));
    expect(r.outcome).toBe("INSUFFICIENT_BASIS");
    expect(r.projectedCents).toBeNull();
  });

  it("no último dia do ano a projeção iguala o observado", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1234.56)],
      elapsedDaysInYear: 365,
      totalDaysInYear: 365,
      method: "LINEAR_BY_CALENDAR_DAY",
    }));
    expect(r.projectedCents).toBe(cents(1234.56));
  });
});

describe("SERVICE_BASED está em standby", () => {
  it("devolve METHOD_IN_STANDBY em vez de inventar um número", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1000)], method: "SERVICE_BASED",
    }));
    expect(r.outcome).toBe("METHOD_IN_STANDBY");
    expect(r.projectedCents).toBeNull();
    expect(r.basisLabel).toContain("standby");
  });

  it("não rebenta o dashboard — uma projeção é informativa", () => {
    // Contraste com PRORATED na T11, que lança: lá o valor entra em facturação.
    expect(() => projectAnnual(input({ method: "SERVICE_BASED" }))).not.toThrow();
  });
});

describe("fonte indisponível", () => {
  it("um mês null marca o resultado como parcial e não conta como zero", () => {
    const monthly: (MoneyCents | null)[] = [cents(1000), null, cents(200)];
    const r = projectAnnual(input({ monthlyCents: monthly, currentMonth: 3 }));
    expect(r.partial).toBe(true);
    expect(r.observedCents).toBe(cents(1200));
  });

  it("o método canónico ignora o mês em falta no denominador", () => {
    const r = projectAnnual(input({
      monthlyCents: [cents(1000), null, cents(200)],
      currentMonth: 3,
      method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    expect(r.basisCount).toBe(1);
    expect(r.partial).toBe(true);
  });

  it("todos os meses em falta dá base insuficiente", () => {
    const r = projectAnnual(input({
      monthlyCents: [null, null, null],
      currentMonth: 3,
      method: "LINEAR_BY_COMPLETED_MONTHS",
    }));
    expect(r.outcome).toBe("INSUFFICIENT_BASIS");
  });
});

describe("determinismo", () => {
  it("o mesmo input dá sempre o mesmo resultado", () => {
    const i = input({ monthlyCents: [cents(1000), cents(1000), cents(200)] });
    expect(JSON.stringify(projectAnnual(i))).toBe(JSON.stringify(projectAnnual(i)));
  });
});
