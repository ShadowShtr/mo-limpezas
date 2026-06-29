// Ponto de entrada do parsing de extratos bancários.
// Recebe o tipo de ficheiro + buffer e devolve movimentos normalizados já com
// fingerprint, prontos a gravar em bank_transactions.

import { parseCsv } from "./csv";
import { parseXlsx, isLegacyXls } from "./xlsx";
import { parsePdf } from "./pdf";
import { mapRowsToTransactions, type NormalizedTransaction } from "./normalize";
import { transactionFingerprint, fileHash } from "./fingerprint";

export type BankFileType = "csv" | "xlsx" | "xls" | "pdf";

export interface ParsedTransaction extends NormalizedTransaction {
  fingerprint: string;
}

export type ParseStatementResult =
  | { ok: true; transactions: ParsedTransaction[]; skipped: number }
  | { ok: false; error: string };

const MAX_TEXT_BYTES = 25 * 1024 * 1024; // proteção contra ficheiros texto gigantes

function withFingerprints(txs: NormalizedTransaction[]): ParsedTransaction[] {
  return txs.map((t) => ({ ...t, fingerprint: transactionFingerprint(t) }));
}

export async function parseStatement(
  fileType: BankFileType,
  buffer: Buffer,
): Promise<ParseStatementResult> {
  try {
    if (fileType === "csv") {
      if (buffer.length > MAX_TEXT_BYTES) return { ok: false, error: "Ficheiro CSV demasiado grande." };
      const text = buffer.toString("utf-8");
      const table = parseCsv(text);
      if (table.headers.length === 0) return { ok: false, error: "CSV vazio ou ilegível." };
      const { transactions, skipped } = mapRowsToTransactions(table.headers, table.rows);
      if (transactions.length === 0) {
        return { ok: false, error: "Não foi possível identificar movimentos no CSV (verifique as colunas data/valor)." };
      }
      return { ok: true, transactions: withFingerprints(transactions), skipped };
    }

    if (fileType === "xls") {
      // .xls antigo (binário OLE2) não é suportado neste MVP.
      if (isLegacyXls(buffer)) {
        return {
          ok: false,
          error: "Formato .xls antigo não suportado. Guarde como .xlsx ou CSV e tente novamente.",
        };
      }
      // alguns .xls exportados são na verdade XLSX ou CSV renomeados — tenta XLSX
      return parseExcel(buffer);
    }

    if (fileType === "xlsx") {
      return parseExcel(buffer);
    }

    if (fileType === "pdf") {
      const res = parsePdf(buffer);
      if (!res.ok) return res;
      return { ok: true, transactions: withFingerprints(res.transactions), skipped: 0 };
    }

    return { ok: false, error: "Tipo de ficheiro não suportado." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Erro ao processar o ficheiro." };
  }
}

async function parseExcel(buffer: Buffer): Promise<ParseStatementResult> {
  const table = await parseXlsx(buffer);
  if (table.headers.length === 0) return { ok: false, error: "Excel vazio ou ilegível." };
  const { transactions, skipped } = mapRowsToTransactions(table.headers, table.rows);
  if (transactions.length === 0) {
    return { ok: false, error: "Não foi possível identificar movimentos no Excel (verifique as colunas data/valor)." };
  }
  return { ok: true, transactions: withFingerprints(transactions), skipped };
}

export { fileHash };
export type { NormalizedTransaction } from "./normalize";
