// Parser de XLSX (Excel moderno) sem dependências externas pesadas: um .xlsx é
// um ZIP de XML, e o projeto já usa `jszip`. Lê a primeira folha e devolve uma
// grelha de strings, reaproveitando o mesmo formato do CSV.
//
// .xls antigo (binário OLE2/BIFF) NÃO é suportado aqui — ver detectXls().

import JSZip from "jszip";
import type { CsvTable } from "./csv";

/** Os ficheiros .xls antigos começam pela assinatura OLE2 (D0 CF 11 E0…). */
export function isLegacyXls(buffer: Buffer | Uint8Array): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf &&
    buffer[2] === 0x11 && buffer[3] === 0xe0
  );
}

function colToIndex(ref: string): number {
  // "A1" / "AB12" → índice 0-based da coluna
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** Extrai a tabela de sharedStrings (índice → texto). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRegex.exec(xml)) !== null) {
    const inner = m[1];
    // junta todos os <t>…</t> (texto pode estar dividido em runs <r><t>)
    const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    out.push(decodeXmlEntities(texts.join("")));
  }
  return out;
}

export async function parseXlsx(buffer: Buffer | Uint8Array): Promise<CsvTable> {
  const zip = await JSZip.loadAsync(buffer);

  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? parseSharedStrings(await sharedFile.async("string")) : [];

  // primeira folha do workbook
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (!zip.file(sheetPath)) {
    const anySheet = Object.keys(zip.files).find((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
    if (anySheet) sheetPath = anySheet;
  }
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) return { headers: [], rows: [] };
  const sheetXml = await sheetFile.async("string");

  const grid: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRegex.exec(sheetXml)) !== null) {
    const rowXml = rm[1];
    const cells: string[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRegex.exec(rowXml)) !== null) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const body = cm[2] ?? "";
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1] ?? "";
      const type = attrs.match(/t="([^"]+)"/)?.[1] ?? "n";
      const colIdx = ref ? colToIndex(ref) : cells.length;

      let value = "";
      if (type === "s") {
        const idx = parseInt(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "-1", 10);
        value = shared[idx] ?? "";
      } else if (type === "inlineStr") {
        const texts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
        value = decodeXmlEntities(texts.join(""));
      } else {
        value = decodeXmlEntities(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
      }
      while (cells.length < colIdx) cells.push("");
      cells[colIdx] = value.trim();
    }
    grid.push(cells);
  }

  // descarta linhas vazias e escolhe cabeçalho (1ª linha com >= 2 células)
  const nonEmpty = grid.filter((r) => r.some((c) => c !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  let headerIdx = nonEmpty.findIndex((r) => r.filter((c) => c !== "").length >= 2);
  if (headerIdx === -1) headerIdx = 0;

  return {
    headers: nonEmpty[headerIdx],
    rows: nonEmpty.slice(headerIdx + 1),
  };
}
