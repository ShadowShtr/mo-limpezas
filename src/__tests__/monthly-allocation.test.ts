// ============================================================================
// T11 — Distribuição da avença mensal
// ============================================================================
// A invariante central da task: SUM(alocações) === valor mensal, sempre.
// Estes testes existem porque a Cobrança Diária perde um cêntimo em qualquer
// avença cujo valor não seja divisível pelo número de ocorrências — todos os
// meses, em silêncio.

import { describe, it, expect } from "vitest";
import {
  allocateMonthlyAmount,
  allocationFor,
  canonicalOrder,
  compareOccurrences,
  splitCentsEvenly,
  sumMonthlyAllocations,
  type AllocatableOccurrence,
} from "@/domain/billing/monthly-allocation";
import { eurosToCents, type MoneyCents } from "@/domain/billing/money";

const c = (n: number) => n as MoneyCents;

function occurrences(count: number, month = "2026-08"): AllocatableOccurrence[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `occ-${String(i).padStart(3, "0")}`,
    occurrenceDate: `${month}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
}

describe("splitCentsEvenly — nunca perde um cêntimo", () => {
  it("100,00 € em 3 dá 33,34 / 33,33 / 33,33", () => {
    const parts = splitCentsEvenly(c(10000), 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("a divisão antiga perdia mesmo esse cêntimo", () => {
    const antiga = Math.round((100 / 3) * 100) / 100; // 33.33
    expect(antiga * 3).toBeCloseTo(99.99, 2);
    expect(splitCentsEvenly(c(10000), 3).reduce((a, b) => a + b, 0)).toBe(10000);
  });

  const counts = [1, 2, 3, 7, 11, 28, 30, 31];
  const amounts = [0, 1, 100, 999, 9999, 10000, 100000];

  it.each(counts)("soma fecha para qualquer valor com %i ocorrências", (count) => {
    for (const total of amounts) {
      const parts = splitCentsEvenly(c(total), count);
      expect(parts).toHaveLength(count);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("resto 0: todas as quotas iguais", () => {
    const parts = splitCentsEvenly(c(9000), 3);
    expect(parts).toEqual([3000, 3000, 3000]);
  });

  it("resto 1: só a primeira leva o cêntimo extra", () => {
    const parts = splitCentsEvenly(c(10), 3);
    expect(parts).toEqual([4, 3, 3]);
  });

  it("resto N-1: só a última fica sem o extra", () => {
    const parts = splitCentsEvenly(c(11), 3); // base 3, resto 2
    expect(parts).toEqual([4, 4, 3]);
  });

  it("1 cêntimo em 3 ocorrências: uma leva tudo, as outras zero", () => {
    const parts = splitCentsEvenly(c(1), 3);
    expect(parts).toEqual([1, 0, 0]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("zero cêntimos distribui zeros", () => {
    expect(splitCentsEvenly(c(0), 4)).toEqual([0, 0, 0, 0]);
  });

  it("negativos (estorno) mantêm a forma e a soma", () => {
    const parts = splitCentsEvenly(c(-10000), 3);
    expect(parts).toEqual([-3334, -3333, -3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-10000);
  });

  it("recusa contagem inválida em vez de dividir por zero", () => {
    expect(() => splitCentsEvenly(c(100), 0)).toThrow(RangeError);
    expect(() => splitCentsEvenly(c(100), -1)).toThrow(RangeError);
    expect(() => splitCentsEvenly(c(100), 1.5)).toThrow(RangeError);
  });
});

describe("ordem canónica", () => {
  it("ordena por data e depois por id", () => {
    const list: AllocatableOccurrence[] = [
      { id: "b", occurrenceDate: "2026-08-10" },
      { id: "a", occurrenceDate: "2026-08-10" },
      { id: "c", occurrenceDate: "2026-08-01" },
    ];
    const { ordered } = canonicalOrder(list);
    expect(ordered.map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("não depende da ordem de chegada", () => {
    const base = occurrences(7);
    const shuffled = [...base].reverse();
    const a = allocateMonthlyAmount({ totalCents: c(10000), occurrences: base });
    const b = allocateMonthlyAmount({ totalCents: c(10000), occurrences: shuffled });
    expect(b.allocations).toEqual(a.allocations);
  });

  it("remove ids repetidos e conta-os", () => {
    const list: AllocatableOccurrence[] = [
      { id: "a", occurrenceDate: "2026-08-01" },
      { id: "a", occurrenceDate: "2026-08-05" },
      { id: "b", occurrenceDate: "2026-08-02" },
    ];
    const { ordered, duplicateCount } = canonicalOrder(list);
    expect(ordered.map((o) => o.id)).toEqual(["a", "b"]);
    expect(duplicateCount).toBe(1);
  });

  it("datas inválidas vão para o fim, sem rebentar", () => {
    const list: AllocatableOccurrence[] = [
      { id: "mau", occurrenceDate: "72026-01-01" }, // corrupção real já vista
      { id: "bom", occurrenceDate: "2026-08-01" },
    ];
    const { ordered, invalidDateCount } = canonicalOrder(list);
    expect(ordered.map((o) => o.id)).toEqual(["bom", "mau"]);
    expect(invalidDateCount).toBe(1);
  });

  it("compareOccurrences é uma ordem total consistente", () => {
    const x = { id: "a", occurrenceDate: "2026-08-01" };
    const y = { id: "b", occurrenceDate: "2026-08-01" };
    expect(compareOccurrences(x, y)).toBeLessThan(0);
    expect(compareOccurrences(y, x)).toBeGreaterThan(0);
    expect(compareOccurrences(x, x)).toBe(0);
  });
});

describe("allocateMonthlyAmount", () => {
  it("distribui e fecha a soma", () => {
    const result = allocateMonthlyAmount({
      totalCents: eurosToCents(300),
      occurrences: occurrences(7),
    });
    expect(result.outcome).toBe("ALLOCATED");
    expect(sumMonthlyAllocations(result.allocations)).toBe(30000);
    expect(result.allocatedCents).toBe(30000);
    expect(result.unallocatedCents).toBe(0);
  });

  it.each([1, 2, 3, 7, 11, 28, 30, 31])(
    "soma fecha com %i ocorrências para todos os valores do plano",
    (count) => {
      for (const euros of [0, 0.01, 1, 10, 99.99, 100, 1000]) {
        const total = eurosToCents(euros)!;
        const result = allocateMonthlyAmount({ totalCents: total, occurrences: occurrences(count) });
        expect(result.outcome).toBe("ALLOCATED");
        expect(sumMonthlyAllocations(result.allocations)).toBe(total);
      }
    },
  );

  it("marca quem carrega o resto", () => {
    const result = allocateMonthlyAmount({ totalCents: c(10), occurrences: occurrences(3) });
    expect(result.allocations.map((a) => a.carriesRemainder)).toEqual([true, false, false]);
  });

  it("valor sem ocorrências não divide por zero nem inventa receita", () => {
    const result = allocateMonthlyAmount({ totalCents: eurosToCents(300), occurrences: [] });
    expect(result.outcome).toBe("UNALLOCATED_NO_OCCURRENCES");
    expect(result.allocations).toHaveLength(0);
    expect(result.allocatedCents).toBe(0);
    // O dinheiro contratado continua visível — não desaparece em silêncio.
    expect(result.unallocatedCents).toBe(30000);
  });

  it("sem valor mensal é diferente de valor zero", () => {
    const semValor = allocateMonthlyAmount({ totalCents: null, occurrences: occurrences(3) });
    expect(semValor.outcome).toBe("UNALLOCATED_NO_AMOUNT");
    expect(semValor.totalCents).toBeNull();

    const zero = allocateMonthlyAmount({ totalCents: c(0), occurrences: occurrences(3) });
    expect(zero.outcome).toBe("ALLOCATED");
    expect(zero.totalCents).toBe(0);
    expect(zero.allocations).toHaveLength(3);
  });

  it("é determinística: mesma entrada, mesma saída", () => {
    const input = { totalCents: c(99999), occurrences: occurrences(11) };
    const a = allocateMonthlyAmount(input);
    const b = allocateMonthlyAmount(input);
    expect(b).toEqual(a);
  });

  it("PRORATED está em standby e falha alto em vez de adivinhar", () => {
    expect(() =>
      allocateMonthlyAmount({
        totalCents: c(10000),
        occurrences: occurrences(3),
        policy: "PRORATED",
      }),
    ).toThrow(/standby/);
  });

  it("recusa totalCents inválido", () => {
    expect(() =>
      allocateMonthlyAmount({ totalCents: 1.5 as MoneyCents, occurrences: occurrences(2) }),
    ).toThrow(RangeError);
  });

  it("allocationFor encontra e devolve null para não elegível", () => {
    const result = allocateMonthlyAmount({ totalCents: c(300), occurrences: occurrences(3) });
    expect(allocationFor(result, "occ-001")?.amountCents).toBe(100);
    expect(allocationFor(result, "inexistente")).toBeNull();
  });

  it("valores grandes não perdem precisão", () => {
    const total = eurosToCents(1_000_000)!; // 100 milhões de cêntimos
    const result = allocateMonthlyAmount({ totalCents: total, occurrences: occurrences(31) });
    expect(sumMonthlyAllocations(result.allocations)).toBe(total);
  });
});
