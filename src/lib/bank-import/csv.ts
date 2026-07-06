// Parser de CSV para extratos bancários.
// Deteta automaticamente o delimitador (, ; tab ou |) e suporta campos com aspas.
// Deteta se existe mesmo uma linha de cabeçalho reconhecível — extratos bancários
// portugueses muitas vezes começam logo com dados, sem cabeçalho nenhum.

import { HEADER_HINTS, normalizeHeader } from "./normalize";

export interface CsvTable {
  headers: string[];
  rows: string[][];
  hasRecognizedHeader: boolean;
}

const ALL_HINTS = Object.values(HEADER_HINTS).flat();

/** Deteta o delimitador mais provável na primeira linha "rica". */
export function detectCsvDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = sample.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** Parse de uma linha CSV respeitando aspas duplas (RFC 4180). */
function parseLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Quantas células de uma linha já parecem um cabeçalho de extrato bancário conhecido. */
function countHeaderLikeCells(cells: string[]): number {
  let count = 0;
  for (const cell of cells) {
    const norm = normalizeHeader(cell);
    if (!norm) continue;
    if (ALL_HINTS.some((hint) => norm === hint || norm.includes(hint))) count++;
  }
  return count;
}

/** Linha de saldo inicial/final (ex.: "Saldo Inicial;;;;;1200,00") — não é um movimento. */
function isBalanceOnlyRow(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c !== "");
  if (nonEmpty.length === 0 || nonEmpty.length > 2) return false;
  return nonEmpty.some((c) => {
    const norm = normalizeHeader(c);
    return norm.includes("saldo") || norm.includes("balance");
  });
}

/**
 * Converte texto CSV numa tabela.
 * Cabeçalho = a primeira linha em que pelo menos 2 células dão match nos
 * termos conhecidos de extratos bancários (data/descrição/débito/crédito/...).
 * Se nenhuma linha cumprir isso, o ficheiro é tratado como SEM cabeçalho:
 * geram-se nomes de coluna sintéticos (col_0, col_1, ...) e todas as linhas
 * contam como dados — cabe à UI (mapeamento manual) resolver isto.
 */
export function parseCsvFile(text: string): CsvTable {
  const clean = text.replace(/^﻿/, "");
  const delim = detectCsvDelimiter(clean);
  const lines = clean.split(/\r?\n/);

  const parsed: string[][] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    parsed.push(parseLine(line, delim));
  }
  if (parsed.length === 0) return { headers: [], rows: [], hasRecognizedHeader: false };

  let headerIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (countHeaderLikeCells(parsed[i]) >= 2) { headerIdx = i; break; }
  }

  if (headerIdx === -1) {
    const width = Math.max(...parsed.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => `col_${i}`);
    const rows = parsed.filter((r) => !isBalanceOnlyRow(r) && r.some((c) => c !== ""));
    return { headers, rows, hasRecognizedHeader: false };
  }

  const headers = parsed[headerIdx];
  const headerLine = headers.join(delim);
  const rows = parsed
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== ""))
    .filter((r) => r.join(delim) !== headerLine) // cabeçalho repetido a meio do ficheiro
    .filter((r) => !isBalanceOnlyRow(r));

  return { headers, rows, hasRecognizedHeader: true };
}
