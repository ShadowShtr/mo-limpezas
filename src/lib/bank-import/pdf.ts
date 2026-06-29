// Parser de PDF de extratos — BEST-EFFORT, apenas para PDF com texto extraível.
// Não usa dependências externas: descomprime os streams FlateDecode com o zlib
// nativo do Node e reconstrói as linhas a partir dos operadores de texto.
//
// Se o PDF for digitalizado/imagem (sem texto), devolve mensagem clara — o MVP
// não faz OCR.

import { inflateSync } from "zlib";
import { parseDate, parseAmount, normalizeDescription, type NormalizedTransaction } from "./normalize";

export type PdfParseResult =
  | { ok: true; transactions: NormalizedTransaction[] }
  | { ok: false; error: string };

const SCANNED_MSG =
  "PDF digitalizado/imagem ainda não suportado nesta versão. Exporte o extrato em CSV ou Excel.";

/** Descodifica escapes de strings PDF: \( \) \\ \n \r \t e octais \ddd. */
function decodePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g) => {
    switch (g) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "(": return "(";
      case ")": return ")";
      case "\\": return "\\";
      default: return String.fromCharCode(parseInt(g, 8));
    }
  });
}

/** Extrai texto de um content stream descomprimido, com quebras de linha. */
function extractTextFromContent(content: string): string {
  let out = "";
  // Operadores de posicionamento que indicam nova linha
  const tokenRegex =
    /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\((?:(?:[^()\\]|\\.)*)\)\s*Tj|T\*|'|"|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(content)) !== null) {
    const full = m[0];
    if (full.endsWith("TJ")) {
      // array de strings e ajustes numéricos: [(ab) -250 (cd)] TJ
      const inner = m[1];
      const parts = [...inner.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((p) => decodePdfString(p[1]));
      out += parts.join("");
    } else if (full.endsWith("Tj")) {
      const str = full.match(/\(((?:[^()\\]|\\.)*)\)\s*Tj/)?.[1] ?? "";
      out += decodePdfString(str);
    } else if (full === "T*" || full === "'" || full === '"') {
      out += "\n";
    } else if (full.endsWith("Td")) {
      // mudança de linha quando há deslocamento vertical
      const dy = parseFloat(m[3] ?? "0");
      if (Math.abs(dy) > 0.01) out += "\n";
    }
  }
  return out;
}

/** Descomprime e concatena o texto de todos os streams FlateDecode do PDF. */
function extractAllText(buffer: Buffer): string {
  const bin = buffer.toString("latin1");
  let text = "";
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRegex.exec(bin)) !== null) {
    const raw = Buffer.from(m[1], "latin1");
    let content: string | null = null;
    try {
      content = inflateSync(raw).toString("latin1");
    } catch {
      // stream não comprimido ou outro filtro: tenta usar como está
      content = /BT|Tj|TJ/.test(m[1]) ? m[1] : null;
    }
    if (content) text += extractTextFromContent(content) + "\n";
  }
  return text;
}

const DATE_RE = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b/;
const AMOUNT_RE = /-?\(?\d{1,3}(?:[.\s]\d{3})*,\d{2}\)?|-?\(?\d+\.\d{2}\)?/g;

/**
 * Heurística de linha: cada linha com uma data + pelo menos um valor monetário
 * é tratada como um movimento. O último valor é o montante; a descrição é o
 * texto entre a data e o primeiro valor.
 */
function rowsFromText(text: string): NormalizedTransaction[] {
  const txs: NormalizedTransaction[] = [];
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const dateMatch = line.match(DATE_RE);
    if (!dateMatch) continue;
    const iso = parseDate(dateMatch[1]);
    if (!iso) continue;

    const amounts = line.match(AMOUNT_RE);
    if (!amounts || amounts.length === 0) continue;
    const value = parseAmount(amounts[amounts.length - 1]);
    if (value == null || value === 0) continue;

    const afterDate = line.slice(dateMatch.index! + dateMatch[1].length);
    const firstAmountIdx = afterDate.search(AMOUNT_RE);
    const description = normalizeDescription(
      firstAmountIdx > -1 ? afterDate.slice(0, firstAmountIdx) : afterDate,
    );

    txs.push({
      transaction_date: iso,
      value_date: null,
      description,
      counterparty_name: null,
      reference: null,
      amount: Math.abs(Math.round(value * 100) / 100),
      direction: value >= 0 ? "credit" : "debit",
      currency: "EUR",
      raw_data: { line },
    });
  }
  return txs;
}

export function parsePdf(buffer: Buffer): PdfParseResult {
  let text = "";
  try {
    text = extractAllText(buffer);
  } catch {
    return { ok: false, error: SCANNED_MSG };
  }
  // pouco texto legível → muito provavelmente digitalizado
  const printable = text.replace(/[^\x20-\x7EÀ-ſ]/g, "").trim();
  if (printable.length < 20) return { ok: false, error: SCANNED_MSG };

  const transactions = rowsFromText(text);
  if (transactions.length === 0) {
    return {
      ok: false,
      error:
        "Não foi possível extrair movimentos deste PDF automaticamente. " +
        "Exporte o extrato em CSV ou Excel.",
    };
  }
  return { ok: true, transactions };
}
