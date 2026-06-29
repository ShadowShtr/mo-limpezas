import { describe, it, expect } from "vitest";
import { parseDate, parseAmount, mapRowsToTransactions, deburr } from "@/lib/bank-import/normalize";
import { parseCsv } from "@/lib/bank-import/csv";
import { transactionFingerprint } from "@/lib/bank-import/fingerprint";
import { scoreMatch, suggestMatches, confidenceLabel, type CashEntryLike } from "@/lib/bank-import/matching";

describe("normalize · parseDate", () => {
  it("interpreta dd/mm/yyyy", () => expect(parseDate("05/03/2026")).toBe("2026-03-05"));
  it("interpreta dd-mm-yyyy", () => expect(parseDate("05-03-2026")).toBe("2026-03-05"));
  it("interpreta dd.mm.yyyy", () => expect(parseDate("05.03.2026")).toBe("2026-03-05"));
  it("aceita ISO", () => expect(parseDate("2026-03-05")).toBe("2026-03-05"));
  it("ano a 2 dígitos", () => expect(parseDate("05/03/26")).toBe("2026-03-05"));
  it("rejeita lixo", () => expect(parseDate("não é data")).toBeNull());
  it("rejeita mês inválido", () => expect(parseDate("05/13/2026")).toBeNull());
});

describe("normalize · parseAmount", () => {
  it("vírgula decimal pt-PT", () => expect(parseAmount("1.234,56")).toBe(1234.56));
  it("ponto decimal en", () => expect(parseAmount("1,234.56")).toBe(1234.56));
  it("valor simples com vírgula", () => expect(parseAmount("12,50")).toBe(12.5));
  it("negativo por sinal", () => expect(parseAmount("-45,00")).toBe(-45));
  it("negativo por parênteses", () => expect(parseAmount("(45,00)")).toBe(-45));
  it("com símbolo de moeda", () => expect(parseAmount("1.000,00 €")).toBe(1000));
  it("número puro", () => expect(parseAmount(99.9)).toBe(99.9));
  it("rejeita vazio", () => expect(parseAmount("")).toBeNull());
});

describe("normalize · deburr", () => {
  it("remove acentos e baixa", () => expect(deburr("Descrição")).toBe("descricao"));
});

describe("csv · parse + map", () => {
  const csv = [
    "Data;Descrição;Valor",
    "05/03/2026;TRANSF CLIENTE ABC;1.234,56",
    "06/03/2026;PAGAMENTO FORNECEDOR;-200,00",
    "", // linha vazia ignorada
  ].join("\n");

  it("deteta delimitador ; e cabeçalhos", () => {
    const t = parseCsv(csv);
    expect(t.headers).toEqual(["Data", "Descrição", "Valor"]);
    expect(t.rows.length).toBe(2);
  });

  it("mapeia para movimentos com direção correta", () => {
    const t = parseCsv(csv);
    const { transactions } = mapRowsToTransactions(t.headers, t.rows);
    expect(transactions.length).toBe(2);
    expect(transactions[0]).toMatchObject({ transaction_date: "2026-03-05", amount: 1234.56, direction: "credit" });
    expect(transactions[1]).toMatchObject({ transaction_date: "2026-03-06", amount: 200, direction: "debit" });
  });

  it("suporta colunas separadas débito/crédito", () => {
    const t = parseCsv(["Data,Descritivo,Débito,Crédito", "01/01/2026,Salário,,1500,00", "02/01/2026,Renda,800.00,"].join("\n"));
    const { transactions } = mapRowsToTransactions(t.headers, t.rows);
    expect(transactions[0]).toMatchObject({ direction: "credit", amount: 1500 });
    expect(transactions[1]).toMatchObject({ direction: "debit", amount: 800 });
  });
});

describe("fingerprint", () => {
  const base = {
    transaction_date: "2026-03-05", value_date: null, description: "Transf ABC",
    counterparty_name: null, reference: null, amount: 100, direction: "credit" as const,
    currency: "EUR", raw_data: {},
  };
  it("é determinístico", () => {
    expect(transactionFingerprint(base)).toBe(transactionFingerprint({ ...base }));
  });
  it("difere quando o valor muda", () => {
    expect(transactionFingerprint(base)).not.toBe(transactionFingerprint({ ...base, amount: 101 }));
  });
});

describe("matching · scoreMatch", () => {
  const tx = {
    transaction_date: "2026-03-05", amount: 1234.56, direction: "credit" as const,
    description: "TRANSF CLIENTE ABC LDA", counterparty_name: "ABC LDA", reference: "FT2026/1",
  };

  it("dá pontuação alta a valor+data+descrição iguais", () => {
    const entry: CashEntryLike = { id: "e1", type: "entrada", amount: 1234.56, description: "Fatura cliente ABC", date: "2026-03-05" };
    const r = scoreMatch(tx, entry);
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(70);
  });

  it("descarta direção oposta", () => {
    const entry: CashEntryLike = { id: "e2", type: "saida", amount: 1234.56, description: "x", date: "2026-03-05" };
    expect(scoreMatch(tx, entry)).toBeNull();
  });

  it("descarta valor muito diferente", () => {
    const entry: CashEntryLike = { id: "e3", type: "entrada", amount: 50, description: "x", date: "2026-03-05" };
    expect(scoreMatch(tx, entry)).toBeNull();
  });

  it("suggestMatches ordena e filtra por minScore", () => {
    const entries: CashEntryLike[] = [
      { id: "a", type: "entrada", amount: 1234.56, description: "Fatura ABC", date: "2026-03-05" },
      { id: "b", type: "entrada", amount: 1234.56, description: "outra coisa", date: "2026-02-01" },
      { id: "c", type: "saida", amount: 1234.56, description: "x", date: "2026-03-05" },
    ];
    const res = suggestMatches(tx, entries, { minScore: 50 });
    expect(res[0].entryId).toBe("a");
    expect(res.every((r) => r.score >= 50)).toBe(true);
  });

  it("rótulos de confiança", () => {
    expect(confidenceLabel(95)).toBe("muito provável");
    expect(confidenceLabel(75)).toBe("provável");
    expect(confidenceLabel(55)).toBe("possível");
    expect(confidenceLabel(20)).toBe("baixa confiança");
  });
});
