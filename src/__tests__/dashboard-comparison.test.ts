// T15 — Comparação entre períodos e política de denominador zero.
//
// O defeito coberto: o dashboard resolve a divisão por zero devolvendo 0%.
// Um mês com 0 € de receita e 3000 € de custos mostra "0%" ao lado de
// "−3000,00 €". O 0% não é a percentagem: é a ausência dela, disfarçada.

import { describe, it, expect } from "vitest";
import {
  compareAmounts,
  compareCounts,
  percentDelta,
  percentOf,
  trendOf,
  unavailableComparison,
} from "@/domain/dashboard/comparison";
import { legacyMarginPct, legacyTableMarginPct } from "@/domain/dashboard/legacy-dashboard";
import { amount, unavailable } from "@/domain/billing/financial-model";
import { eurosToCents } from "@/domain/billing/money";

const cents = (v: number) => eurosToCents(v)!;

describe("percentDelta", () => {
  it("calcula a variação quando há base", () => {
    expect(percentDelta(cents(150), cents(100))).toEqual({ kind: "VALUE", percent: 50 });
    expect(percentDelta(cents(50), cents(100))).toEqual({ kind: "VALUE", percent: -50 });
    expect(percentDelta(cents(100), cents(100))).toEqual({ kind: "VALUE", percent: 0 });
  });

  it("base zero com valor actual é NOT_COMPARABLE, não +Infinity%", () => {
    const r = percentDelta(cents(1000), cents(0));
    expect(r.kind).toBe("NOT_COMPARABLE");
    expect(r.percent).toBeNull();
  });

  it("ambos zero é UNCHANGED_ZERO, distinto de uma variação de 0%", () => {
    expect(percentDelta(cents(0), cents(0)).kind).toBe("UNCHANGED_ZERO");
    expect(percentDelta(cents(100), cents(100)).kind).toBe("VALUE");
  });

  it("um lado em falta é UNAVAILABLE", () => {
    expect(percentDelta(null, cents(100)).kind).toBe("UNAVAILABLE");
    expect(percentDelta(cents(100), null).kind).toBe("UNAVAILABLE");
  });

  it("nunca devolve NaN nem Infinity", () => {
    const casos: [number | null, number | null][] = [
      [0, 0], [1000, 0], [0, 1000], [-500, 0], [-500, -1000], [1000, -500],
    ];
    for (const [c, p] of casos) {
      const r = percentDelta(c == null ? null : cents(c), p == null ? null : cents(p));
      if (r.percent != null) {
        expect(Number.isFinite(r.percent)).toBe(true);
      }
    }
  });

  it("base negativa não inverte o sinal da variação", () => {
    // Margem de −1000 € para −500 € é uma melhoria: +50%, não −50%.
    expect(percentDelta(cents(-500), cents(-1000))).toEqual({ kind: "VALUE", percent: 50 });
  });
});

describe("percentOf", () => {
  it("dá a razão quando há denominador", () => {
    expect(percentOf(cents(25), cents(100))).toEqual({ kind: "VALUE", percent: 25 });
  });

  it("margem negativa sobre receita zero é NOT_COMPARABLE, não 0%", () => {
    const canonico = percentOf(cents(-3000), cents(0));
    expect(canonico.kind).toBe("NOT_COMPARABLE");
    expect(canonico.percent).toBeNull();

    // O que os dois sítios do código actual devolvem para o mesmo caso.
    expect(legacyMarginPct(-3000, 0)).toBe(0);
    expect(legacyTableMarginPct(-3000, 0)).toBe(0);
  });

  it("zero sobre zero é UNCHANGED_ZERO", () => {
    expect(percentOf(cents(0), cents(0)).kind).toBe("UNCHANGED_ZERO");
  });

  it("fonte em falta é UNAVAILABLE", () => {
    expect(percentOf(null, cents(100)).kind).toBe("UNAVAILABLE");
  });
});

describe("trendOf", () => {
  it("distingue subida, descida, estável e desconhecido", () => {
    expect(trendOf(cents(1))).toBe("up");
    expect(trendOf(cents(-1))).toBe("down");
    expect(trendOf(cents(0))).toBe("flat");
    expect(trendOf(null)).toBe("unknown");
  });
});

describe("compareAmounts", () => {
  it("compara dois montantes disponíveis", () => {
    const c = compareAmounts(amount(cents(150), "invoice"), amount(cents(100), "invoice"));
    expect(c.absoluteDeltaCents).toBe(cents(50));
    expect(c.percent).toEqual({ kind: "VALUE", percent: 50 });
    expect(c.trend).toBe("up");
    expect(c.snapshot).toBe(false);
  });

  it("um montante indisponível não vira zero", () => {
    const c = compareAmounts(unavailable("cash_flow", "falhou"), amount(cents(100), "cash_flow"));
    expect(c.currentCents).toBeNull();
    expect(c.absoluteDeltaCents).toBeNull();
    expect(c.percent.kind).toBe("UNAVAILABLE");
    expect(c.trend).toBe("unknown");
  });

  it("marca a comparação de saldos", () => {
    const c = compareAmounts(
      amount(cents(10), "invoice"), amount(cents(5), "invoice"), { snapshot: true },
    );
    expect(c.snapshot).toBe(true);
  });

  it("um montante PARTIAL continua comparável, mas mantém a marca no amount", () => {
    const parcial = amount(cents(80), "invoice", "PARTIAL");
    const c = compareAmounts(parcial, amount(cents(100), "invoice"));
    expect(c.currentCents).toBe(cents(80));
    expect(parcial.completeness).toBe("PARTIAL");
  });
});

describe("compareCounts", () => {
  it("usa a mesma política do dinheiro", () => {
    expect(compareCounts(12, 10).percent).toEqual({ kind: "VALUE", percent: 20 });
    expect(compareCounts(5, 0).percent.kind).toBe("NOT_COMPARABLE");
    expect(compareCounts(0, 0).percent.kind).toBe("UNCHANGED_ZERO");
  });

  it("dá o delta absoluto e a direcção", () => {
    const c = compareCounts(8, 10);
    expect(c.absoluteDelta).toBe(-2);
    expect(c.trend).toBe("down");
  });
});

describe("unavailableComparison", () => {
  it("não inventa um delta de zero quando não há período anterior", () => {
    const c = unavailableComparison();
    expect(c.currentCents).toBeNull();
    expect(c.previousCents).toBeNull();
    expect(c.absoluteDeltaCents).toBeNull();
    expect(c.percent.kind).toBe("UNAVAILABLE");
  });
});
