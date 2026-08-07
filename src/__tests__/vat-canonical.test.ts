// ============================================================================
// T11 — IVA canónico
// ============================================================================
// Invariante fechada: net + vat = gross, exactamente, em qualquer taxa.

import { describe, it, expect } from "vitest";
import {
  applyVat,
  extractVatFromGross,
  sumVatBreakdowns,
  vatApplies,
  type VatPolicy,
} from "@/domain/billing/vat";
import { eurosToCents, type MoneyCents } from "@/domain/billing/money";
import { legacyWithVat } from "@/domain/billing/legacy-formulas";

const c = (n: number) => n as MoneyCents;
const pol = (applyVatFlag: boolean, ratePct: number, clientExempt = false): VatPolicy => ({
  applyVat: applyVatFlag,
  ratePct,
  clientExempt,
});

describe("quando há imposto", () => {
  it("apply_vat false não gera imposto", () => {
    expect(vatApplies(pol(false, 23))).toBe(false);
    const r = applyVat(c(10000), pol(false, 23));
    expect(r).toMatchObject({ netCents: 10000, vatCents: 0, grossCents: 10000, appliedRatePct: 0 });
  });

  it("taxa 0% não gera imposto mesmo com apply_vat true", () => {
    expect(vatApplies(pol(true, 0))).toBe(false);
    expect(applyVat(c(10000), pol(true, 0)).vatCents).toBe(0);
  });

  it("cliente isento anula o apply_vat da linha", () => {
    expect(vatApplies(pol(true, 23, true))).toBe(false);
    expect(applyVat(c(10000), pol(true, 23, true)).grossCents).toBe(10000);
  });

  it("taxa não finita é tratada como sem imposto", () => {
    expect(vatApplies(pol(true, Number.NaN))).toBe(false);
    expect(vatApplies(pol(true, -5))).toBe(false);
  });
});

describe("as taxas portuguesas", () => {
  it.each([6, 13, 23])("%i%% sobre 100,00 €", (rate) => {
    const r = applyVat(eurosToCents(100)!, pol(true, rate));
    expect(r.netCents).toBe(10000);
    expect(r.vatCents).toBe(rate * 100);
    expect(r.grossCents).toBe(10000 + rate * 100);
    expect(r.appliedRatePct).toBe(rate);
  });

  it("23% sobre 0,01 € arredonda o imposto para 0", () => {
    const r = applyVat(c(1), pol(true, 23));
    expect(r.vatCents).toBe(0);
    expect(r.grossCents).toBe(1);
    // A invariante mantém-se mesmo quando o imposto desaparece no arredondamento.
    expect(r.netCents + r.vatCents).toBe(r.grossCents);
  });

  it("base 0 dá tudo 0", () => {
    const r = applyVat(c(0), pol(true, 23));
    expect(r).toMatchObject({ netCents: 0, vatCents: 0, grossCents: 0 });
  });
});

describe("invariante net + vat = gross", () => {
  it("vale para toda a grelha de bases e taxas", () => {
    for (const base of [0, 1, 3, 7, 99, 100, 9999, 10000, 123456, 99999999]) {
      for (const rate of [0, 6, 13, 23, 100]) {
        const r = applyVat(c(base), pol(true, rate));
        expect(r.netCents + r.vatCents).toBe(r.grossCents);
      }
    }
  });

  it("vale para valores negativos (estorno)", () => {
    const r = applyVat(c(-10000), pol(true, 23));
    expect(r.vatCents).toBe(-2300);
    expect(r.netCents + r.vatCents).toBe(r.grossCents);
  });
});

describe("soma de decomposições", () => {
  it("soma os IVAs já arredondados, não o IVA da base somada", () => {
    // Três linhas de 0,03 €: cada uma dá 1 cêntimo de IVA a 23% (0,0069 → 0,01).
    // A soma das linhas dá 3 cêntimos; o IVA da base somada (0,09 €) daria 2.
    // A fatura tem de bater com as linhas que o cliente vê.
    const parts = [c(3), c(3), c(3)].map((v) => applyVat(v, pol(true, 23)));
    const total = sumVatBreakdowns(parts);
    expect(total.netCents).toBe(9);
    expect(total.vatCents).toBe(3);
    expect(applyVat(c(9), pol(true, 23)).vatCents).toBe(2); // a conta alternativa
    expect(total.netCents + total.vatCents).toBe(total.grossCents);
  });

  it("soma vazia é neutra", () => {
    const total = sumVatBreakdowns([]);
    expect(total).toMatchObject({ netCents: 0, vatCents: 0, grossCents: 0, appliedRatePct: 0 });
  });

  it("taxas mistas deixam appliedRatePct a 0 em vez de mentir", () => {
    const total = sumVatBreakdowns([
      applyVat(c(10000), pol(true, 23)),
      applyVat(c(10000), pol(true, 6)),
    ]);
    expect(total.appliedRatePct).toBe(0);
    expect(total.vatCents).toBe(2300 + 600);
  });

  it("uma só taxa preserva-a", () => {
    const total = sumVatBreakdowns([
      applyVat(c(10000), pol(true, 23)),
      applyVat(c(5000), pol(true, 23)),
      applyVat(c(5000), pol(false, 23)), // sem imposto não conta para a taxa
    ]);
    expect(total.appliedRatePct).toBe(23);
  });
});

describe("caminho inverso", () => {
  it("recupera a base de um total com IVA", () => {
    const r = extractVatFromGross(c(12300), pol(true, 23));
    expect(r.netCents).toBe(10000);
    expect(r.vatCents).toBe(2300);
    expect(r.grossCents).toBe(12300);
  });

  it("mantém a invariante mesmo quando a divisão não é reversível", () => {
    for (const gross of [1, 7, 33, 12301, 99999]) {
      const r = extractVatFromGross(c(gross), pol(true, 23));
      expect(r.netCents + r.vatCents).toBe(r.grossCents);
      expect(r.grossCents).toBe(gross);
    }
  });

  it("sem imposto devolve a base igual ao total", () => {
    const r = extractVatFromGross(c(12300), pol(false, 23));
    expect(r.netCents).toBe(12300);
    expect(r.vatCents).toBe(0);
  });
});

describe("compatibilidade com o withVat antigo", () => {
  it("o gross canónico bate com legacyWithVat num valor isolado", () => {
    for (const euros of [10, 99.99, 100, 1234.56]) {
      const canonical = applyVat(eurosToCents(euros)!, pol(true, 23));
      const legacy = legacyWithVat(euros, true, 23);
      expect(canonical.grossCents).toBe(eurosToCents(legacy));
    }
  });

  it("mas o antigo não expunha o imposto — era impossível reconciliar", () => {
    const legacy = legacyWithVat(100, true, 23);
    expect(legacy).toBe(123);
    // Não há forma de saber, a partir de 123, quanto disto é imposto sem
    // reconstruir a conta. O canónico devolve as três parcelas de uma vez.
    const canonical = applyVat(eurosToCents(100)!, pol(true, 23));
    expect(canonical.vatCents).toBe(2300);
  });
});
