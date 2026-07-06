// Monta a pré-visualização de uma importação de extrato: mapeia colunas,
// normaliza linhas, calcula fingerprints e classifica cada linha (válida /
// erro / duplicado interno / duplicado já existente na BD) — sem gravar nada.

import { mapBankColumns, mapRowsToTransactions, type FieldKey, type NormalizedTransaction, type Direction } from "./normalize";
import { createBankTransactionFingerprint, detectInternalDuplicates, detectDatabaseDuplicates } from "./fingerprint";

export interface ParsedTransaction extends NormalizedTransaction {
  fingerprint: string;
}

export type PreviewRowStatus = "valid" | "error" | "duplicate_internal" | "duplicate_existing";

export interface PreviewRow {
  index: number;
  status: PreviewRowStatus;
  date: string | null;
  description: string;
  debit: number | null;
  credit: number | null;
  amount: number | null;
  direction: Direction | null;
  error?: string;
}

export interface ImportPreview {
  headers: string[];
  detectedMapping: Partial<Record<FieldKey, number>>;
  hasRecognizedHeader: boolean;
  totalRows: number;
  validCount: number;
  errorCount: number;
  duplicateInternalCount: number;
  duplicateExistingCount: number;
  sampleErrors: { row: number; reason: string }[];
  rows: PreviewRow[];
  transactions: ParsedTransaction[]; // válidas e não duplicadas — prontas a gravar
}

export interface BuildPreviewOptions {
  hasRecognizedHeader: boolean;
  columnOverride?: Partial<Record<FieldKey, number | null>>;
  existingFingerprints?: Set<string>;
}

export function buildImportPreview(
  headers: string[],
  rows: string[][],
  options: BuildPreviewOptions,
): ImportPreview {
  const detectedMapping = mapBankColumns(headers, options.columnOverride);
  const { rows: mapped, errorCount } = mapRowsToTransactions(headers, rows, detectedMapping);

  const validRows = mapped.filter((r) => r.status === "valid");
  const errorRows = mapped.filter((r) => r.status === "error");

  // fingerprint por linha válida, na ordem do ficheiro (occurrence index estável
  // para distinguir movimentos legítimos idênticos — ver fingerprint.ts).
  const occurrenceCounts = new Map<string, number>();
  const validWithFp = validRows.map((r) => {
    const baseKey = [
      r.tx.transaction_date,
      r.tx.amount.toFixed(2),
      r.tx.direction,
      r.tx.description.toLowerCase().trim(),
      (r.tx.reference ?? "").toLowerCase().trim(),
    ].join("|");
    const idx = occurrenceCounts.get(baseKey) ?? 0;
    occurrenceCounts.set(baseKey, idx + 1);
    return { row: r, fingerprint: createBankTransactionFingerprint(r.tx, idx) };
  });

  const internalDuplicates = detectInternalDuplicates(validWithFp.map((v) => v.fingerprint));
  const existingDuplicates = options.existingFingerprints
    ? detectDatabaseDuplicates(validWithFp.map((v) => v.fingerprint), options.existingFingerprints)
    : new Set<string>();

  const seenCount = new Map<string, number>();
  const previewRows: PreviewRow[] = [];
  const transactions: ParsedTransaction[] = [];
  let duplicateInternalCount = 0;
  let duplicateExistingCount = 0;

  for (const { row, fingerprint } of validWithFp) {
    const occurrence = seenCount.get(fingerprint) ?? 0;
    seenCount.set(fingerprint, occurrence + 1);

    let status: PreviewRowStatus = "valid";
    if (existingDuplicates.has(fingerprint)) {
      status = "duplicate_existing";
      duplicateExistingCount++;
    } else if (occurrence > 0 && internalDuplicates.has(fingerprint)) {
      status = "duplicate_internal";
      duplicateInternalCount++;
    }

    previewRows.push({
      index: row.index,
      status,
      date: row.tx.transaction_date,
      description: row.tx.description,
      debit: row.debit,
      credit: row.credit,
      amount: row.tx.amount,
      direction: row.tx.direction,
    });
    if (status === "valid") transactions.push({ ...row.tx, fingerprint });
  }

  for (const row of errorRows) {
    previewRows.push({
      index: row.index,
      status: "error",
      date: row.date,
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      amount: null,
      direction: null,
      error: row.reason,
    });
  }
  previewRows.sort((a, b) => a.index - b.index);

  return {
    headers,
    detectedMapping,
    hasRecognizedHeader: options.hasRecognizedHeader,
    totalRows: rows.length,
    validCount: transactions.length,
    errorCount,
    duplicateInternalCount,
    duplicateExistingCount,
    sampleErrors: errorRows.slice(0, 10).map((r) => ({ row: r.index + 1, reason: r.reason })),
    rows: previewRows,
    transactions,
  };
}
