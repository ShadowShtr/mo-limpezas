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

describe("fixture real 'descarga.csv' (extrato completo, 117 movimentos, vírgula + aspas)", () => {
  // Ficheiro real fornecido pelo dono (cabeçalho de aviso + nome do titular +
  // linhas em branco antes do cabeçalho real, exatamente como o banco exporta).
  const descargaCsv = [
    '"Segunda-feira, 6 de Julho de 2026","","","",""',
    '"MONICA SOFIA MARQUES RIBEIRO","","","",""',
    '"","","","",""',
    '"Saldos e movimentos","","","",""',
    '"","","","",""',
    '"Listagem de Movimentos","","","",""',
    '"Data Operação","Data valor","Descrição","Montante( EUR )","Saldo Contabilístico( EUR )"',
    '"03-07-2026","03-07-2026","Levantamento Carregado","-70","11304.3"',
    '"03-07-2026","03-07-2026","Monica","-388.8","11374.3"',
    '"03-07-2026","03-07-2026","Transferência para Monica Sofia Marques Ribeiro","-50","11763.1"',
    '"03-07-2026","03-07-2026","Imp.Selo-Mo Limpezas-E05869186","-0.05","11813.1"',
    '"03-07-2026","03-07-2026","Comissao-Mo Limpezas-E05869186","-1.25","11813.15"',
    '"03-07-2026","03-07-2026","Mo Limpezas","-175","11814.4"',
    '"03-07-2026","03-07-2026","Trf. MB WAY de Dra Rita Andrea Cordeiro Veiga","42","11989.4"',
    '"03-07-2026","03-07-2026","Transferência de Dra Vania Cristina Branco Mateus","420","11947.4"',
    '"03-07-2026","03-07-2026","Imp.Selo-Ordenado - Junho-E05868802","-0.05","11527.4"',
    '"03-07-2026","03-07-2026","Comissao-Ordenado - Junho-E05868802","-1.25","11527.45"',
    '"03-07-2026","03-07-2026","Ordenado - Junho","-430","11528.7"',
    '"03-07-2026","03-07-2026","Imp.Selo-Ordenado - Junho-E05868756","-0.05","11958.7"',
    '"03-07-2026","03-07-2026","Comissao-Ordenado - Junho-E05868756","-1.25","11958.75"',
    '"03-07-2026","03-07-2026","Ordenado - Junho","-1300","11960"',
    '"03-07-2026","03-07-2026","Ordenado - Junho","-1058.67","13260"',
    '"03-07-2026","03-07-2026","Imp.Selo-Ordenado - Junho-E00779423","-0.05","14318.67"',
    '"03-07-2026","03-07-2026","Comissao-Ordenado - Junho-E00779423","-1.25","14318.72"',
    '"03-07-2026","03-07-2026","Ordenado - Junho-E00779423","-1078.27","14319.97"',
    '"03-07-2026","03-07-2026","Transferência para Monica Sofia Marques Ribeiro","-30","15398.24"',
    '"03-07-2026","03-07-2026","Trf.Imed.   de Natalia Cardoso Nielsen-R22964231","31.5","15428.24"',
    '"03-07-2026","03-07-2026","Pastelaria Norbertoscarre","-2.3","15396.74"',
    '"03-07-2026","03-07-2026","Trf. MB WAY de Carina Isabel Carvalho Piedade","15","15399.04"',
    '"03-07-2026","03-07-2026","Trf. MB WAY de Liliana Monica Fernandes Silva","100","15384.04"',
    '"03-07-2026","03-07-2026","Trf. MB WAY para Igor Ricardo Bezerra Silva","-15","15284.04"',
    '"03-07-2026","03-07-2026","Transferência para Monica Sofia Marques Ribeiro","-40","15299.04"',
    '"03-07-2026","03-07-2026","Trf. MB WAY de Claudia Patricia Costeira Luca","157.5","15339.04"',
    '"03-07-2026","03-07-2026","Transferência de Agito Global Limited","1589.65","15181.54"',
    '"03-07-2026","03-07-2026","Transferência de Condominio Rua Gil Eanes Lote 104","56.54","13591.89"',
    '"03-07-2026","03-07-2026","Transferência de Rui Manuel Moreira Marques","755","13535.35"',
    '"03-07-2026","03-07-2026","Transferência de N Ribeiro J Ribeiro-servico Limpeza,lda","108.24","12780.35"',
    '"03-07-2026","03-07-2026","Transferência de Sun Charge, Unipessoal Lda","135.3","12672.11"',
    '"02-07-2026","02-07-2026","Transferência de Cond R Liberdade Lote 1","34.91","12536.81"',
    '"02-07-2026","02-07-2026","Transferência de Ana Cristina Brito Santos Nobre","76","12501.9"',
    '"02-07-2026","02-07-2026","Trf. MB WAY de Carlos Manuel C Cristovao Garces","76","12425.9"',
    '"02-07-2026","02-07-2026","Transferência de Vertente Humana Emp Tra Temporario Lda","297.66","12349.9"',
    '"02-07-2026","02-07-2026","Pastelaria Norbertos","-5","12052.24"',
    '"02-07-2026","02-07-2026","Levantamento Carregado","-30","12057.24"',
    '"02-07-2026","02-07-2026","Transferência para Monica Sofia Marques Ribeiro","-6","12087.24"',
    '"02-07-2026","02-07-2026","Transferência de Carla Alexandra Teixeira Angelino Dinis Da Silva","40.48","12093.24"',
    '"02-07-2026","02-07-2026","Transferência de Carla Alexandra Teixeira Angelino Dinis Da Silva","176","12052.76"',
    '"02-07-2026","02-07-2026","Transferência de Cond Av Comb G Guerra 7,lg D J Palha,r Palh Blanco","151.29","11876.76"',
    '"02-07-2026","02-07-2026","Trf. MB WAY para Joana Da Paixao Dos Anjos","-15","11725.47"',
    '"02-07-2026","02-07-2026","Transferência de Reservilustrada Lda","442.8","11740.47"',
    '"02-07-2026","02-07-2026","Trf. MB WAY de Maria Emília De Oliveira Santos","126","11297.67"',
    '"02-07-2026","02-07-2026","Trf. MB WAY de Maria Gabriela Marques Fe","42","11171.67"',
    '"02-07-2026","01-07-2026","Transferência para Gilceli A Coelho","20","11129.67"',
    '"02-07-2026","02-07-2026","Transferência de Cond Predio Sito Rua Julio Jose Pedro Goes 13","88.68","11109.67"',
    '"02-07-2026","02-07-2026","Una Seguros","-347.48","11020.99"',
    '"02-07-2026","02-07-2026","Una Seguros Vida","-80.72","11368.47"',
    '"02-07-2026","02-07-2026","Aegon Santander Portugal Nao Vida","-13.04","11449.19"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Mariana Francisco Silva","132","11462.23"',
    '"01-07-2026","01-07-2026","Transferência de Cond.predio Sito R. Manuel Rodrigues G Girio N 14","83.26","11330.23"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Maria Teresa Esteves Teles Touguinha Biscaia Da Silva","84","11246.97"',
    '"01-07-2026","01-07-2026","Levantamento Carregado","-10","11162.97"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Ana Margarida Nunes Francisquinho","126","11172.97"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Ines Novo De Sa Nogueira","126","11046.97"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Claudia Sofia Alves Cruz Prioste Gomes","80","10920.97"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Catarina Alexandra Franco Rodr","230.52","10840.97"',
    '"01-07-2026","01-07-2026","Transferência de Anteoportugal, Lda","180.81","10610.45"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Marina Filipa M Santos","92","10429.64"',
    '"01-07-2026","01-07-2026","Transferência de Dra Maria Antonia Silva Pascoa Cs","76","10337.64"',
    '"01-07-2026","01-07-2026","Transferência de Micael F C R T Unipessoal,lda","221.71","10261.64"',
    '"01-07-2026","01-07-2026","Transferência para Monica Sofia Marques Ribeiro","-40","10039.93"',
    '"01-07-2026","01-07-2026","Transferência de Etapa Refletida Unipessoal Lda","22.2","10079.93"',
    '"01-07-2026","01-07-2026","Transferência para Monica Sofia Marques Ribeiro","-30","10057.73"',
    '"01-07-2026","01-07-2026","Trf. MB WAY para Gilceli A Coelho","-20","10087.73"',
    '"01-07-2026","01-07-2026","Transferência de Helena F Silva","40","10107.73"',
    '"01-07-2026","01-07-2026","Transferência para Monica Sofia Marques Ribeiro","-13","10067.73"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Zulmira M O L Oliveira","44","10080.73"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Isabel Sofia Bento Fernandes Goncalves","120","10036.73"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Alexandra Isabel Ramalho Rocha","292","9916.73"',
    '"01-07-2026","01-07-2026","Transferência para Monica Ribeiro","-4","9624.73"',
    '"01-07-2026","01-07-2026","Imp.Selo-Monica Ribeiro-02378653","-0.05","9628.73"',
    '"01-07-2026","01-07-2026","Comisso Trf Cred SEPA+ -Monica Ribeiro-02378653","-1.25","9628.78"',
    '"01-07-2026","01-07-2026","Transferência de Filipa Figueiras - Events, Unipessoal Lda","826.56","9630.03"',
    '"01-07-2026","01-07-2026","Festim Real Unip Lda","-79.9","8803.47"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Mónica Sofia Marques Ribeiro","39.95","8883.37"',
    '"01-07-2026","01-07-2026","Trf. MB WAY para Rute C Costa","-30","8843.42"',
    '"01-07-2026","01-07-2026","Resta 33 Sabores","-4.6","8873.42"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Carina Alexandra P Henriques Castro","132","8878.02"',
    '"01-07-2026","01-07-2026","Comissão de disponibilização de cartão de débito","-6","8746.02"',
    '"01-07-2026","01-07-2026","Imposto do selo sobre comissão","-0.24","8752.02"',
    '"01-07-2026","01-07-2026","Uber Eats","-15.34","8752.26"',
    '"01-07-2026","01-07-2026","Transferência de Liliana Ribeiro","120","8767.6"',
    '"01-07-2026","01-07-2026","Transferência para Monica Sofia Marques Ribeiro","-30","8647.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Ana Teresa Garces Ferreira Sardinha","176","8677.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Pedro Pereira","185","8501.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Ana Filipa Coias Martins","80","8316.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Sandra Maria Ferreira Pinto","115","8236.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Ricardo Alexandre Silva Ferreira Cs","40","8121.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Thamara Hessel Silva","84","8081.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Eduardo Jose Madeira Albuquerque Machado","315","7997.6"',
    '"01-07-2026","01-07-2026","Transferência de Maria Preciosa Piedade Batista","88","7682.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Daniela Figueiredo Ramos","180","7594.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Marina Alexandra Rodrigues Carvalho","38","7414.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Eng Paulo Jorge M Carvalho Parreira","252","7376.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Dra Patricia Isabel Henriques Miguel Sa","36","7124.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Mari Leena Manty Faria Carvalho","132","7088.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Antonio Pedro Hilario Galhardo","138","6956.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Susana Carla Rodrigues Miguel","120","6818.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Jose Miguel Barbosa Costa","320","6698.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Irene Goncalves Bernardo","168","6378.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Liliete Rosario Santos Pereira","84","6210.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Eng Domingos Monteiro Morgado","85","6126.6"',
    '"01-07-2026","01-07-2026","Trf. MB WAY de Marisa Sa Teixeira","80","6041.6"',
    '"01-07-2026","01-07-2026","Transferência de Mosca Portugal Lda","314.24","5961.6"',
    '"01-07-2026","01-07-2026","Transferência de Condominio Predio Sito Travessa Dos Pinheiros Lt 55","69.83","5647.36"',
    '"01-07-2026","01-07-2026","Medicare","-19.9","5577.53"',
    '"01-07-2026","01-07-2026","Una Seguros","-39.22","5597.43"',
    '"01-07-2026","01-07-2026","Una Seguros Vida","-98.03","5636.65"',
    '"01-07-2026","01-07-2026","Transferência de Condominio Do Predio Sito Na Praceta Joao Goncalves Zarco Lote 51","69.83","5734.68"',
    '"01-07-2026","01-07-2026","Transferência de Condominio Do Predio Sito Na Rua Diogo Afonso Lote 67","69.83","5664.85"',
    '"01-07-2026","01-07-2026","Transferência de Condominio Predio Sito Praceta G","87.55","5595.02"',
    '"01-07-2026","01-07-2026","Transferência de Condominio Do Predio Sito Quinta","87.55","5507.47"',
    '"01-07-2026","01-07-2026","Transferência de Susana Isabel Costa Pais","42","5419.92"',
    '"01-07-2026","01-07-2026","Transferência de Cond Predio Rua Pedro Sintra -lt 82","92.69","5377.92"',
    '"01-07-2026","01-07-2026","Transferência de Condom Ed Horta Del R P D R N 6 11 B 1 6","811.8","5285.23"',
    '"","","","",""',
    '"","","","",""',
    '"","","","",""',
  ].join("\n");

  it("deteta o cabeçalho real (salta as linhas de aviso/nome/'Listagem de Movimentos') e ignora linhas em branco finais", () => {
    const t = parseCsvFile(descargaCsv);
    expect(t.hasRecognizedHeader).toBe(true);
    expect(t.headers).toEqual(["Data Operação", "Data valor", "Descrição", "Montante( EUR )", "Saldo Contabilístico( EUR )"]);
    expect(t.rows.length).toBe(117);
  });

  it("importa os 117 movimentos sem erros, com Montante( EUR ) como valor e Saldo Contabilístico( EUR ) nunca usado", () => {
    const buf = Buffer.from(descargaCsv, "utf-8");
    const result = parseCsvStatement(buf, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.errorCount).toBe(0);
    expect(preview.validCount).toBe(117);

    const cols = mapBankColumns(preview.headers);
    expect(cols.amount).toBe(3);
    expect(cols.balance).toBe(4);
  });

  it("preserva a ordem original do ficheiro (transactions[i].index é sequencial e crescente)", () => {
    const buf = Buffer.from(descargaCsv, "utf-8");
    const result = parseCsvStatement(buf, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const indexes = result.preview.transactions.map((t) => t.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes[0]).toBe(0);
    expect(indexes[indexes.length - 1]).toBe(116);
  });

  it("preserva os valores exatos pedidos pelo dono, com sinal correto (-70, -388.80, -0.05, 42, 420, 1589.65)", () => {
    const buf = Buffer.from(descargaCsv, "utf-8");
    const result = parseCsvStatement(buf, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signed = result.preview.transactions.map((t) => (t.direction === "debit" ? -t.amount : t.amount));
    for (const expected of [-70, -388.8, -0.05, 42, 420, 1589.65]) {
      expect(signed).toContain(expected);
    }
    // nenhum saldo (ex.: 11304.3, 11374.3) aparece como valor de movimento
    expect(signed.every((v) => v !== 11304.3 && v !== 11374.3)).toBe(true);
  });

  it("reimportar o mesmo ficheiro não duplica nenhum dos 117 movimentos", () => {
    const buf = Buffer.from(descargaCsv, "utf-8");
    const first = parseCsvStatement(buf, {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const existingFingerprints = new Set(first.preview.transactions.map((t) => t.fingerprint));

    const second = parseCsvStatement(buf, { existingFingerprints });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.preview.transactions.length).toBe(0);
    expect(second.preview.duplicateExistingCount).toBe(117);
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
