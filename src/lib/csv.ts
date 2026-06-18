// Caracteres que iniciam fórmulas maliciosas no Excel/Google Sheets
const FORMULA_CHARS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Sanitiza um valor para exportação CSV.
 * - Escapa aspas duplas internas.
 * - Prefixa com ' valores que iniciem com caracteres de fórmula (proteção CSV injection).
 * - Envolve sempre em aspas duplas.
 */
export function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (FORMULA_CHARS.some((c) => s.startsWith(c))) {
    s = "'" + s; // prefixo inerte — Excel trata como texto
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/** Gera conteúdo CSV a partir de cabeçalho + linhas. */
export function buildCsv(headers: string[], rows: (unknown[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n"); // BOM UTF-8 para Excel
}

/** Desencadeia download do ficheiro CSV no browser. */
export function downloadCsv(filename: string, headers: string[], rows: (unknown[])[]): void {
  const content = buildCsv(headers, rows);
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
