// Ponto de entrada do parsing de extratos bancários.
// Nesta fase só CSV é aceite — XLS/XLSX/PDF ficam para uma fase futura
// (os módulos xlsx.ts/pdf.ts continuam no repo, só deixam de ser chamados).

import { parseCsvFile } from "./csv";
import { buildImportPreview, type BuildPreviewOptions, type ImportPreview } from "./preview";
import { fileHash } from "./fingerprint";

export type BankFileType = "csv";

export type ParseCsvResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; error: string };

const MAX_TEXT_BYTES = 25 * 1024 * 1024; // proteção contra ficheiros texto gigantes

export function parseCsvStatement(
  buffer: Buffer,
  options: Omit<BuildPreviewOptions, "hasRecognizedHeader">,
): ParseCsvResult {
  if (buffer.length > MAX_TEXT_BYTES) return { ok: false, error: "Ficheiro CSV demasiado grande." };
  const text = buffer.toString("utf-8");
  const table = parseCsvFile(text);
  if (table.headers.length === 0 || table.rows.length === 0) {
    return { ok: false, error: "CSV vazio ou ilegível." };
  }
  const preview = buildImportPreview(table.headers, table.rows, {
    ...options,
    hasRecognizedHeader: table.hasRecognizedHeader,
  });
  return { ok: true, preview };
}

export { fileHash };
export type { NormalizedTransaction, FieldKey, Direction } from "./normalize";
export type { ParsedTransaction, ImportPreview, PreviewRow, PreviewRowStatus } from "./preview";
