import { describe, it, expect } from "vitest";
import { parseBankDate, parseMoney, mapBankColumns, mapRowsToTransactions, deburr, normalizeHeader } from "@/lib/bank-import/normalize";
import { parseCsvFile, detectCsvDelimiter } from "@/lib/bank-import/csv";
import { createBankTransactionFingerprint, detectInternalDuplicates, detectDatabaseDuplicates } from "@/lib/bank-import/fingerprint";
import { buildImportPreview } from "@/lib/bank-import/preview";
import { parseCsvStatement } from "@/lib/bank-import";
import { scoreMatch, suggestMatches, confidenceLabel, type CashEntryLike } from "@/lib/bank-import/matching";

describe("normalize · parseBankDate", () => {
  it("interpreta dd/mm/yyyy", () => expect(parseBankDate("05/03/2026")).toBe("2026-03-05"));
  it("interpreta dd-mm-yyyy", () => expect(parseBankDate("05-03-2026")).toBe("2026-03-05"));
  it("interpreta dd.mm.yyyy", () => expect(parseBankDate("05.03.2026")).toBe("2026-03-05"));
  it("aceita ISO", () => expect(parseBankDate("2026-03-05")).toBe("2026-03-05"));
  it("ano a 2 dígitos", () => expect(parseBankDate("05/03/26")).toBe("2026-03-05"));
  it("rejeita lixo", () => expect(parseBankDate("não é data")).toBeNull());
  it("rejeita mês inválido", () => expect(parseBankDate("05/13/2026")).toBeNull());
  it("fixture real: 03-07-2026", () => expect(parseBankDate("03-07-2026")).toBe("2026-07-03"));
});

describe("normalize · parseMoney", () => {
  it("vírgula decimal pt-PT", () => expect(parseMoney("1.234,56")).toBe(1234.56));
  it("ponto decimal en", () => expect(parseMoney("1,234.56")).toBe(1234.56));
  it("valor simples com vírgula", () => expect(parseMoney("12,50")).toBe(12.5));
  it("negativo por sinal", () => expect(parseMoney("-45,00")).toBe(-45));
  it("negativo por sinal à direita", () => expect(parseMoney("30,00-")).toBe(-30));
  it("negativo por parênteses", () => expect(parseMoney("(45,00)")).toBe(-45));
  it("com símbolo de moeda", () => expect(parseMoney("1.000,00 €")).toBe(1000));
  it("número puro", () => expect(parseMoney(99.9)).toBe(99.9));
  it("rejeita vazio", () => expect(parseMoney("")).toBeNull());
  it("fixture real: -0.05", () => expect(parseMoney("-0.05")).toBe(-0.05));
  it("fixture real: -1300", () => expect(parseMoney("-1300")).toBe(-1300));
  it("fixture real: 1589.65", () => expect(parseMoney("1589.65")).toBe(1589.65));
});

describe("normalize · deburr / normalizeHeader", () => {
  it("remove acentos e baixa", () => expect(deburr("Descrição")).toBe("descricao"));
  it("colapsa espaços em cabeçalhos", () => expect(normalizeHeader("Data  Valor")).toBe("data valor"));
});

describe("csv · detectCsvDelimiter", () => {
  it("deteta ;", () => expect(detectCsvDelimiter("a;b;c\n1;2;3")).toBe(";"));
  it("deteta ,", () => expect(detectCsvDelimiter("a,b,c\n1,2,3")).toBe(","));
});

describe("csv · parseCsvFile + mapBankColumns", () => {
  it("deteta delimitador ; e cabeçalho reconhecido", () => {
    const csv = ["Data;Descrição;Valor", "05/03/2026;TRANSF CLIENTE ABC;1.234,56"].join("\n");
    const t = parseCsvFile(csv);
    expect(t.headers).toEqual(["Data", "Descrição", "Valor"]);
    expect(t.hasRecognizedHeader).toBe(true);
    expect(t.rows.length).toBe(1);
  });

  it("deteta delimitador ,", () => {
    const csv = ["Data,Descrição,Valor", "05/03/2026,TRANSF CLIENTE ABC,1234.56"].join("\n");
    const t = parseCsvFile(csv);
    expect(detectCsvDelimiter(csv)).toBe(",");
    expect(t.rows.length).toBe(1);
  });

  it("mapeia para movimentos com direção correta (coluna Valor única)", () => {
    const csv = [
      "Data;Descrição;Valor",
      "05/03/2026;TRANSF CLIENTE ABC;1.234,56",
      "06/03/2026;PAGAMENTO FORNECEDOR;-200,00",
    ].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    expect(rows.every((r) => r.status === "valid")).toBe(true);
    const valid = rows.filter((r) => r.status === "valid");
    expect(valid[0].tx).toMatchObject({ transaction_date: "2026-03-05", amount: 1234.56, direction: "credit" });
    expect(valid[1].tx).toMatchObject({ transaction_date: "2026-03-06", amount: 200, direction: "debit" });
  });

  it("suporta colunas separadas débito/crédito — débito negativo vira debit, crédito positivo vira credit", () => {
    const csv = ["Data,Descritivo,Débito,Crédito", "01/01/2026,Salário,,1500,00", "02/01/2026,Renda,800.00,"].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    const valid = rows.filter((r) => r.status === "valid");
    expect(valid[0].tx).toMatchObject({ direction: "credit", amount: 1500 });
    expect(valid[1].tx).toMatchObject({ direction: "debit", amount: 800 });
  });

  it("nunca usa a coluna Saldo como valor do movimento", () => {
    const csv = ["Data;Descrição;Débito;Crédito;Saldo", "05/03/2026;Compra;-10,00;;990,00"].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    expect(cols.balance).toBeDefined();
    expect(cols.balance).not.toBe(cols.debit);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    const [row] = rows;
    expect(row.status).toBe("valid");
    if (row.status === "valid") expect(row.tx.amount).toBe(10); // nunca 990
  });

  it("linha de saldo inicial/final é ignorada (não vira movimento)", () => {
    const csv = [
      "Data;Descrição;Débito;Crédito;Saldo",
      "Saldo Inicial;;;;1000,00",
      "05/03/2026;Compra;-10,00;;990,00",
    ].join("\n");
    const t = parseCsvFile(csv);
    expect(t.rows.length).toBe(1); // só a linha de movimento real
  });

  it("cabeçalho repetido a meio do ficheiro é ignorado", () => {
    const csv = [
      "Data;Descrição;Valor",
      "05/03/2026;A;10,00",
      "Data;Descrição;Valor",
      "06/03/2026;B;20,00",
    ].join("\n");
    const t = parseCsvFile(csv);
    expect(t.rows.length).toBe(2);
  });

  it("linha sem data → status error", () => {
    const csv = ["Data;Descrição;Valor", ";Sem data;10,00"].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    expect(rows[0].status).toBe("error");
    if (rows[0].status === "error") expect(rows[0].reason).toMatch(/data/i);
  });

  it("linha sem valor → status error", () => {
    const csv = ["Data;Descrição;Débito;Crédito", "05/03/2026;Sem valor;;"].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    expect(rows[0].status).toBe("error");
  });

  it("valor zero não é importado", () => {
    const csv = ["Data;Descrição;Valor", "05/03/2026;Sem movimento;0,00"].join("\n");
    const t = parseCsvFile(csv);
    const cols = mapBankColumns(t.headers);
    const { rows } = mapRowsToTransactions(t.headers, t.rows, cols);
    expect(rows[0].status).toBe("error");
  });
});

describe("normalize · mapBankColumns com override manual", () => {
  it("permite ao utilizador corrigir a deteção automática", () => {
    const headers = ["col_0", "col_1", "col_2", "col_3"];
    const cols = mapBankColumns(headers, { date: 0, description: 1, debit: 2, credit: null });
    expect(cols).toMatchObject({ date: 0, description: 1, debit: 2 });
    expect(cols.credit).toBeUndefined();
  });
});

describe("fingerprint", () => {
  const base = {
    transaction_date: "2026-03-05", value_date: null, description: "Transf ABC",
    counterparty_name: null, reference: null, amount: 100, direction: "credit" as const,
    currency: "EUR", raw_data: {},
  };
  it("é determinístico", () => {
    expect(createBankTransactionFingerprint(base)).toBe(createBankTransactionFingerprint({ ...base }));
  });
  it("difere quando o valor muda", () => {
    expect(createBankTransactionFingerprint(base)).not.toBe(createBankTransactionFingerprint({ ...base, amount: 101 }));
  });
  it("movimentos idênticos com índices diferentes não colidem", () => {
    expect(createBankTransactionFingerprint(base, 0)).not.toBe(createBankTransactionFingerprint(base, 1));
  });
  it("usa o saldo da linha para distinguir (ignora o índice)", () => {
    const a = { ...base, raw_data: { Saldo: "1.000,00" } };
    const b = { ...base, raw_data: { Saldo: "991,00" } };
    expect(createBankTransactionFingerprint(a, 0)).not.toBe(createBankTransactionFingerprint(b, 0));
    expect(createBankTransactionFingerprint(a, 0)).toBe(createBankTransactionFingerprint(a, 5));
  });
});

describe("deduplicação · detectInternalDuplicates / detectDatabaseDuplicates", () => {
  it("deteta duplicado dentro do próprio ficheiro", () => {
    const fps = ["a", "b", "a", "c", "a"];
    const dup = detectInternalDuplicates(fps);
    expect(dup.get("a")).toBe(2); // 3 ocorrências → 2 a mais
    expect(dup.has("b")).toBe(false);
  });

  it("deteta duplicado já existente na BD", () => {
    const dup = detectDatabaseDuplicates(["a", "b", "c"], new Set(["b"]));
    expect(dup.has("b")).toBe(true);
    expect(dup.has("a")).toBe(false);
  });
});

describe("preview · buildImportPreview", () => {
  it("classifica válidos, erros e duplicados internos/existentes", () => {
    const csv = [
      "Data;Descrição;Valor;Saldo",
      "05/03/2026;Pagamento X;100,00;500,00",
      "05/03/2026;Pagamento X;100,00;500,00", // duplicado exato (mesmo saldo) dentro do ficheiro
      ";Sem data;10,00;",
    ].join("\n");
    const t = parseCsvFile(csv);
    const preview = buildImportPreview(t.headers, t.rows, { hasRecognizedHeader: t.hasRecognizedHeader });
    expect(preview.errorCount).toBe(1);
    expect(preview.totalRows).toBe(3);
    const statuses = preview.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["duplicate_internal", "error", "valid"]);
  });

  it("marca duplicado já existente na BD", () => {
    const csv = ["Data;Descrição;Valor", "05/03/2026;Pagamento X;100,00"].join("\n");
    const t = parseCsvFile(csv);
    const first = buildImportPreview(t.headers, t.rows, { hasRecognizedHeader: t.hasRecognizedHeader });
    const fp = first.transactions[0].fingerprint;
    const second = buildImportPreview(t.headers, t.rows, {
      hasRecognizedHeader: t.hasRecognizedHeader,
      existingFingerprints: new Set([fp]),
    });
    expect(second.rows[0].status).toBe("duplicate_existing");
    expect(second.transactions.length).toBe(0);
  });

  it("ficheiro sem cabeçalho ativa mapeamento manual (hasRecognizedHeader=false)", () => {
    const csv = [
      "03-07-2026;03-07-2026;Imp.Selo-Ordenado - Junho-E05868756;-0.05;;11958.7",
    ].join("\n");
    const t = parseCsvFile(csv);
    expect(t.hasRecognizedHeader).toBe(false);
    expect(t.headers[0]).toBe("col_0");
  });
});

describe("fixture real do vídeo — 6 linhas sem cabeçalho, valores distintos", () => {
  const csvSemCabecalho = [
    "03-07-2026;03-07-2026;Imp.Selo-Ordenado - Junho-E05868756;-0.05;;11958.7",
    "03-07-2026;03-07-2026;Comissao-Ordenado - Junho-E05868756;-1.25;;11958.75",
    "03-07-2026;03-07-2026;Ordenado - Junho;;-1300;",
    "03-07-2026;03-07-2026;Trf.Imed. de Natalia Cardoso Nielsen-R22964231;;31.5;15428.24",
    "03-07-2026;03-07-2026;Transferência para Monica Sofia Marques Ribeiro;-30;;15398.24",
    "03-07-2026;03-07-2026;Transferência de Agito Global Limited;;1589.65;15181.54",
  ].join("\n");

  it("com mapeamento manual, produz os 6 movimentos com os valores e datas exatos do ficheiro", () => {
    const buf = Buffer.from(csvSemCabecalho, "utf-8");
    const columnOverride = { date: 0, valueDate: 1, description: 2, debit: 3, credit: 4, balance: 5 };
    const result = parseCsvStatement(buf, { columnOverride });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.validCount).toBe(6);
    // cada valor absoluto tem de bater com a coluna real do ficheiro — nunca um valor fixo repetido
    const amounts = preview.transactions.map((t) => t.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([0.05, 1.25, 30, 31.5, 1300, 1589.65].sort((a, b) => a - b));
    // nenhum valor vira 6,00 e todas as datas batem com o ficheiro (nunca a data de hoje por omissão)
    expect(preview.transactions.every((t) => t.amount !== 6)).toBe(true);
    expect(preview.transactions.every((t) => t.transaction_date === "2026-07-03")).toBe(true);
    expect(new Set(preview.transactions.map((t) => t.fingerprint)).size).toBe(6); // sem duplicação absurda
  });
});

describe("fixture real do extrato (produção) — cabeçalho 'Montante( EUR )' + 'Saldo Contabilístico( EUR )'", () => {
  // Cabeçalho real confirmado pelo dono: 1 única coluna de valor com sinal (não há Débito/Crédito separados).
  const csvComCabecalhoReal = [
    "Data Operação;Data valor;Descrição;Montante( EUR );Saldo Contabilístico( EUR )",
    "03-07-2026;03-07-2026;Levantamento Carregado;-70,00;11.304,30",
    "03-07-2026;03-07-2026;Monica;-388,80;11.374,30",
    "03-07-2026;03-07-2026;Transferência para Monica Sofia Marques Ribeiro;-50,00;11.763,10",
    "03-07-2026;03-07-2026;Imp.Selo-Mo Limpezas-E05869186;-0,05;11.813,10",
    "03-07-2026;03-07-2026;Comissao-Mo Limpezas-E05869186;-1,25;11.813,15",
    "03-07-2026;03-07-2026;Mo Limpezas;-175,00;11.814,40",
    "03-07-2026;03-07-2026;Trf. MB WAY de Dra Rita Andrea Cordeiro Veiga;42,00;11.989,40",
    "03-07-2026;03-07-2026;Transferência de Dra Vania Cristina Branco Mateus;420,00;11.947,40",
    "03-07-2026;03-07-2026;Imp.Selo-Ordenado - Junho-E05868802;-0,05;11.527,40",
    "03-07-2026;03-07-2026;Comissao-Ordenado - Junho-E05868802;-1,25;11.527,45",
  ].join("\n");

  it("deteta o cabeçalho automaticamente (Montante/Saldo com sufixo '( EUR )')", () => {
    const t = parseCsvFile(csvComCabecalhoReal);
    expect(t.hasRecognizedHeader).toBe(true);
    const cols = mapBankColumns(t.headers);
    expect(cols.date).toBe(0);
    expect(cols.valueDate).toBe(1);
    expect(cols.description).toBe(2);
    expect(cols.amount).toBe(3);
    expect(cols.balance).toBe(4);
    expect(cols.debit).toBeUndefined();
    expect(cols.credit).toBeUndefined();
  });

  it("importa os 10 movimentos com os valores exatos do extrato — nunca 3,00€ nem 6,00€ repetidos", () => {
    const buf = Buffer.from(csvComCabecalhoReal, "utf-8");
    const result = parseCsvStatement(buf, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.hasRecognizedHeader).toBe(true);
    expect(preview.errorCount).toBe(0);
    expect(preview.validCount).toBe(10);

    const signed = preview.transactions.map((t) => (t.direction === "debit" ? -t.amount : t.amount));
    expect(signed).toEqual([-70, -388.8, -50, -0.05, -1.25, -175, 42, 420, -0.05, -1.25]);
    expect(preview.transactions.every((t) => t.transaction_date === "2026-07-03")).toBe(true);
    // o bug de produção repetia sempre +3,00€ — nenhum destes valores é 3
    expect(preview.transactions.every((t) => t.amount !== 3)).toBe(true);
    // o saldo (11.304,30 etc.) nunca deve aparecer como valor do movimento
    expect(preview.transactions.every((t) => ![11304.3, 11374.3, 11763.1].includes(t.amount))).toBe(true);
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

describe("parseCsvStatement · 8 movimentos legítimos iguais não colidem", () => {
  it("ficam com 8 fingerprints distintos (nenhum falso duplicado)", () => {
    const lines = ["Data;Descrição;Valor"];
    for (let i = 0; i < 8; i++) lines.push("09/06/2026;Pagamento Brisa S.A.;9,00");
    const buf = Buffer.from(lines.join("\n"), "utf-8");
    const res = parseCsvStatement(buf, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.transactions.length).toBe(8);
    const fps = new Set(res.preview.transactions.map((t) => t.fingerprint));
    expect(fps.size).toBe(8);
  });
});
