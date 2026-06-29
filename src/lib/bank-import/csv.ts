// Parser de CSV para extratos bancários.
// Deteta automaticamente o delimitador (, ; ou tab) e suporta campos com aspas.
// Saltla linhas de cabeçalho/rodapé que não pareçam dados tabulares.

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** Deteta o delimitador mais provável na primeira linha "rica". */
function detectDelimiter(text: string): string {
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

/**
 * Converte texto CSV numa tabela. Escolhe como cabeçalho a primeira linha
 * com pelo menos 2 colunas não vazias; o resto são linhas de dados com o
 * mesmo nº de colunas (ignora linhas claramente vazias/separadoras).
 */
export function parseCsv(text: string): CsvTable {
  // remove BOM
  const clean = text.replace(/^﻿/, "");
  const delim = detectDelimiter(clean);
  const lines = clean.split(/\r?\n/);

  const parsed: string[][] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    parsed.push(parseLine(line, delim));
  }
  if (parsed.length === 0) return { headers: [], rows: [] };

  // cabeçalho = primeira linha com >= 2 células não vazias
  let headerIdx = parsed.findIndex((r) => r.filter((c) => c !== "").length >= 2);
  if (headerIdx === -1) headerIdx = 0;

  const headers = parsed[headerIdx];
  const rows = parsed
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== ""));

  return { headers, rows };
}
