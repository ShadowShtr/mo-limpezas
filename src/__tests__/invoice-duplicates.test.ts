import { describe, expect, it } from "vitest";
import { findDuplicateMonthlyContractsByLocation } from "@/lib/invoice-duplicates";

// Cobre a lógica pura por trás do bloqueio em generateInvoices
// (src/app/actions/invoices.ts) que evita o bug de duplicação da cobrança do
// "Parque Norte / Alvorada Principal" (duas linhas de avença de 542,62€ na
// mesma fatura por haver dois contratos fixed_monthly ativos para o mesmo
// location_id no mesmo período).

describe("findDuplicateMonthlyContractsByLocation", () => {
  // Cenário 1: generateInvoices bloqueia quando há dois contratos
  // fixed_monthly=true ativos para o mesmo location_id no mesmo período.
  it("deteta dois contratos ativos para o mesmo local", () => {
    const groups = findDuplicateMonthlyContractsByLocation([
      { id: "contract-1", location_id: "loc-alvorada" },
      { id: "contract-2", location_id: "loc-alvorada" },
    ]);
    expect(groups).toEqual([
      { location_id: "loc-alvorada", contract_ids: ["contract-1", "contract-2"] },
    ]);
  });

  // Cenário 2: permite contratos mensais para locais diferentes do mesmo
  // cliente (ou de clientes diferentes) — não são falsos positivos.
  it("não acusa duplicidade entre locais diferentes", () => {
    const groups = findDuplicateMonthlyContractsByLocation([
      { id: "contract-1", location_id: "loc-a" },
      { id: "contract-2", location_id: "loc-b" },
    ]);
    expect(groups).toEqual([]);
  });

  // Cenário 7: a cobrança de uma avença mensal única gera apenas uma linha
  // (um único contrato por local não é sinalizado como duplicado).
  it("não acusa duplicidade quando só há um contrato por local", () => {
    const groups = findDuplicateMonthlyContractsByLocation([
      { id: "contract-1", location_id: "loc-a" },
    ]);
    expect(groups).toEqual([]);
  });

  it("deteta múltiplos grupos duplicados em simultâneo", () => {
    const groups = findDuplicateMonthlyContractsByLocation([
      { id: "c1", location_id: "loc-a" },
      { id: "c2", location_id: "loc-a" },
      { id: "c3", location_id: "loc-b" },
      { id: "c4", location_id: "loc-b" },
      { id: "c5", location_id: "loc-c" },
    ]);
    expect(groups).toEqual([
      { location_id: "loc-a", contract_ids: ["c1", "c2"] },
      { location_id: "loc-b", contract_ids: ["c3", "c4"] },
    ]);
  });

  it("lida com lista vazia sem erro", () => {
    expect(findDuplicateMonthlyContractsByLocation([])).toEqual([]);
  });
});

// Cenário 8: a avença de 542,62€ com IVA 23% gera total aproximado de
// 667,42€ — não 1.334,85€ (o resultado do bug com a linha duplicada).
// Reproduz a mesma fórmula de arredondamento usada em generateInvoices
// (subtotal/vatAmount/total = Math.round(x * 100) / 100).
describe("cálculo do total da avença (regressão do bug de duplicação)", () => {
  const vatFactor = 0.23;

  function computeTotals(lineValues: number[]) {
    const subtotal  = Math.round(lineValues.reduce((s, v) => s + v, 0) * 100) / 100;
    const vatAmount = Math.round(subtotal * vatFactor * 100) / 100;
    const total     = Math.round((subtotal + vatAmount) * 100) / 100;
    return { subtotal, vatAmount, total };
  }

  it("uma única linha de avença gera o total correto", () => {
    const { subtotal, vatAmount, total } = computeTotals([542.62]);
    expect(subtotal).toBeCloseTo(542.62, 2);
    expect(vatAmount).toBeCloseTo(124.80, 2);
    expect(total).toBeCloseTo(667.42, 2);
  });

  it("duas linhas idênticas (o bug) dobravam incorretamente o total", () => {
    const { subtotal, vatAmount, total } = computeTotals([542.62, 542.62]);
    expect(subtotal).toBeCloseTo(1085.24, 2);
    expect(vatAmount).toBeCloseTo(249.61, 2);
    expect(total).toBeCloseTo(1334.85, 2);
    // Documenta a regressão: o total duplicado é o dobro do total correto.
    expect(total).toBeCloseTo(667.42 * 2, 1);
  });
});
