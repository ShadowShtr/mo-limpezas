// ============================================================================
// T11 — Dinheiro em cêntimos
// ============================================================================
// Fixa a política de arredondamento e prova que a aritmética inteira não perde
// nada onde a vírgula flutuante perdia.

import { describe, it, expect } from "vitest";
import {
  ZERO_CENTS,
  assertMoneyCents,
  centsToEuros,
  eurosToCents,
  formatCents,
  isMoneyCents,
  multiplyCents,
  subtractCents,
  sumCents,
  type MoneyCents,
} from "@/domain/billing/money";

const c = (n: number) => n as MoneyCents;

describe("conversão euros ↔ cêntimos", () => {
  it("converte valores comuns", () => {
    expect(eurosToCents(0)).toBe(0);
    expect(eurosToCents(1)).toBe(100);
    expect(eurosToCents(99.99)).toBe(9999);
    expect(eurosToCents(1000)).toBe(100000);
    expect(eurosToCents(0.01)).toBe(1);
  });

  it("null e undefined dão null — não zero", () => {
    expect(eurosToCents(null)).toBeNull();
    expect(eurosToCents(undefined)).toBeNull();
    // A distinção que a T09 já tinha fixado para a avença: "sem base para
    // calcular" nunca pode virar "custa zero euros".
    expect(eurosToCents(0)).toBe(0);
  });

  it("rejeita valores não finitos devolvendo null", () => {
    expect(eurosToCents(Number.NaN)).toBeNull();
    expect(eurosToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("arredonda half-up onde toFixed falharia", () => {
    // O binário mais próximo de 59.985 é ligeiramente MENOR, por isso
    // (59.985).toFixed(2) === "59.98". A política da T11 dá 59,99 €.
    expect((59.985).toFixed(2)).toBe("59.98");
    expect(eurosToCents(59.985)).toBe(5999);
  });

  it("arredonda half-away-from-zero nos negativos", () => {
    expect(eurosToCents(-0.005)).toBe(-1);
    expect(eurosToCents(-1.005)).toBe(-101);
  });

  it("é reversível para valores com dois decimais", () => {
    for (const euros of [0, 0.01, 1.23, 99.99, 100, 1234.56]) {
      expect(centsToEuros(eurosToCents(euros))).toBeCloseTo(euros, 10);
    }
  });

  it("centsToEuros preserva null", () => {
    expect(centsToEuros(null)).toBeNull();
  });
});

describe("aritmética exacta", () => {
  it("0,1 + 0,2 dá exactamente 0,30", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // o defeito que motivou os cêntimos
    const total = sumCents([eurosToCents(0.1)!, eurosToCents(0.2)!]);
    expect(total).toBe(30);
    expect(centsToEuros(total)).toBe(0.3);
  });

  it("soma vazia é zero", () => {
    expect(sumCents([])).toBe(ZERO_CENTS);
  });

  it("soma mil parcelas de um cêntimo sem desvio", () => {
    const parts = Array.from({ length: 1000 }, () => c(1));
    expect(sumCents(parts)).toBe(1000);
  });

  it("subtrai preservando o sinal", () => {
    expect(subtractCents(c(100), c(250))).toBe(-150);
  });

  it("multiplica arredondando uma única vez", () => {
    expect(multiplyCents(c(10000), 0.23)).toBe(2300);
    expect(multiplyCents(c(1), 0.23)).toBe(0); // 0,0023 € → 0 cêntimos
    expect(multiplyCents(c(3), 0.23)).toBe(1); // 0,0069 € → 1 cêntimo
  });

  it("recusa fator não finito", () => {
    expect(() => multiplyCents(c(100), Number.NaN)).toThrow(RangeError);
  });
});

describe("validação", () => {
  it("aceita inteiros seguros", () => {
    expect(isMoneyCents(0)).toBe(true);
    expect(isMoneyCents(-1)).toBe(true);
    expect(isMoneyCents(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("recusa decimais, NaN e não-números", () => {
    expect(isMoneyCents(1.5)).toBe(false);
    expect(isMoneyCents(Number.NaN)).toBe(false);
    expect(isMoneyCents("100")).toBe(false);
    expect(isMoneyCents(null)).toBe(false);
    expect(isMoneyCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it("assertMoneyCents lança com rótulo útil", () => {
    expect(() => assertMoneyCents(1.5, "teste")).toThrow(/teste/);
  });
});

describe("apresentação", () => {
  it("formata em pt-PT", () => {
    expect(formatCents(c(12345))).toBe("123,45 €");
    expect(formatCents(c(0))).toBe("0,00 €");
    expect(formatCents(c(-150))).toBe("-1,50 €");
  });

  it("null aparece como travessão, não como zero", () => {
    expect(formatCents(null)).toBe("—");
  });
});
