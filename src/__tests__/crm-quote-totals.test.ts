// ============================================================================
// CRM — os totais do orçamento, em código puro
// ============================================================================
//
// A paridade com a RPC (o que a base grava mesmo) é provada em
// `crm-quote-totals-parity.pg.test.ts`, com os mesmos casos corridos nos dois
// caminhos. Aqui prova-se a regra em si.
// ============================================================================

import { describe, expect, it } from "vitest";

import {
  computeQuoteTotals,
  computeLineTotal,
  formatEur,
} from "@/domain/crm/quote-totals";

/** Os casos que valem a pena: usados aqui e no teste de paridade com a RPC. */
export const CASOS = [
  {
    nome: "o caso normal — horas e um serviço fixo",
    linhas: [
      { quantity: 20, unitPrice: 12 },
      { quantity: 1, unitPrice: 80 },
    ],
    discountPct: 0,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 320, base: 320, vatAmount: 73.6, total: 393.6 },
  },
  {
    nome: "com desconto de 10%",
    linhas: [
      { quantity: 20, unitPrice: 12 },
      { quantity: 1, unitPrice: 80 },
    ],
    discountPct: 10,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 320, base: 288, vatAmount: 66.24, total: 354.24 },
  },
  {
    nome: "cliente isento — sem IVA",
    linhas: [{ quantity: 10, unitPrice: 15 }],
    discountPct: 0,
    applyVat: false,
    vatRatePct: 23,
    esperado: { subtotal: 150, base: 150, vatAmount: 0, total: 150 },
  },
  {
    nome: "desconto de 100% — fica a zero, e continua a ser um documento",
    linhas: [{ quantity: 4, unitPrice: 25 }],
    discountPct: 100,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 100, base: 0, vatAmount: 0, total: 0 },
  },
  {
    nome: "cêntimos que não fecham — 3 × 33,33",
    linhas: [{ quantity: 3, unitPrice: 33.33 }],
    discountPct: 0,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 99.99, base: 99.99, vatAmount: 23, total: 122.99 },
  },
  {
    nome: "meio cêntimo de imposto — 0,01 € a 23%",
    linhas: [{ quantity: 1, unitPrice: 0.01 }],
    discountPct: 0,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 0.01, base: 0.01, vatAmount: 0, total: 0.01 },
  },
  {
    nome: "muitas linhas pequenas — o arredondamento é por linha",
    linhas: Array.from({ length: 12 }, () => ({ quantity: 1, unitPrice: 8.335 })),
    discountPct: 0,
    applyVat: true,
    vatRatePct: 23,
    esperado: { subtotal: 100.08, base: 100.08, vatAmount: 23.02, total: 123.1 },
  },
] as const;

describe("CRM — totais do orçamento", () => {
  for (const caso of CASOS) {
    it(caso.nome, () => {
      const r = computeQuoteTotals(caso.linhas, {
        discountPct: caso.discountPct,
        applyVat: caso.applyVat,
        vatRatePct: caso.vatRatePct,
      });
      expect(r).toEqual(caso.esperado);
    });
  }

  it("o subtotal é sempre o bruto — o desconto vive na base", () => {
    // Mostrar o subtotal já descontado esconderia o desconto de quem lê o
    // orçamento, e o documento deixaria de explicar o seu próprio total.
    const r = computeQuoteTotals([{ quantity: 1, unitPrice: 100 }], {
      discountPct: 25,
      applyVat: true,
      vatRatePct: 23,
    });
    expect(r.subtotal).toBe(100);
    expect(r.base).toBe(75);
  });

  it("o IVA incide depois do desconto, nunca antes", () => {
    const r = computeQuoteTotals([{ quantity: 1, unitPrice: 200 }], {
      discountPct: 50,
      applyVat: true,
      vatRatePct: 23,
    });
    expect(r.vatAmount).toBe(23);       // 100 × 23%, e não 200 × 23%
    expect(r.total).toBe(123);
  });

  it("base + IVA = total, em todos os casos", () => {
    for (const caso of CASOS) {
      const r = computeQuoteTotals(caso.linhas, caso);
      expect(r.total, caso.nome).toBe(Math.round((r.base + r.vatAmount) * 100) / 100);
    }
  });

  it("taxa de IVA a zero não produz imposto, mesmo com apply_vat", () => {
    const r = computeQuoteTotals([{ quantity: 1, unitPrice: 50 }], {
      applyVat: true,
      vatRatePct: 0,
    });
    expect(r.vatAmount).toBe(0);
    expect(r.total).toBe(50);
  });

  it("sem linhas, tudo a zero — e não NaN", () => {
    expect(computeQuoteTotals([], { vatRatePct: 23 })).toEqual({
      subtotal: 0, base: 0, vatAmount: 0, total: 0,
    });
  });
});

describe("CRM — o que se escreve no formulário nunca dá NaN", () => {
  it("campos vazios, negativos ou inválidos valem zero", () => {
    // Enquanto se escreve, um campo passa por estados impossíveis. Mostrar
    // «€ NaN» no meio disso é pior do que mostrar zero.
    const r = computeQuoteTotals(
      [
        { quantity: Number.NaN, unitPrice: 10 },
        { quantity: 2, unitPrice: Number.NaN },
        { quantity: -5, unitPrice: 10 },
        { quantity: 1, unitPrice: -10 },
        { quantity: 2, unitPrice: 10 },
      ],
      { vatRatePct: 23 },
    );
    expect(r.subtotal).toBe(20);
    expect(Number.isNaN(r.total)).toBe(false);
  });

  it("um desconto fora de 0–100 é contido", () => {
    expect(computeQuoteTotals([{ quantity: 1, unitPrice: 100 }], { discountPct: 150 }).base).toBe(0);
    expect(computeQuoteTotals([{ quantity: 1, unitPrice: 100 }], { discountPct: -50 }).base).toBe(100);
  });

  it("o total de uma linha é o que se mostra ao lado dela", () => {
    expect(computeLineTotal(3, 33.33)).toBe(99.99);
    expect(computeLineTotal(0, 50)).toBe(0);
    expect(computeLineTotal(Number.NaN, 50)).toBe(0);
  });
});

describe("CRM — a apresentação do dinheiro", () => {
  it("é em euros e em português", () => {
    // `toContain` e não igualdade: o separador de milhares do Intl é um
    // espaço não separável, e comparar a string inteira tornaria o teste
    // refém da versão do ICU.
    expect(formatEur(1234.5)).toContain("€");
    expect(formatEur(1234.5)).toContain("1");
    expect(formatEur(0)).toContain("0");
  });
});
