// Algoritmo de conciliação: dá uma pontuação (0–100) à semelhança entre um
// movimento bancário e um lançamento financeiro (cash_flow_entry).
// Puro (sem I/O) → testável isoladamente. NÃO confirma nada: só sugere.

import { deburr } from "./normalize";

export interface BankTxLike {
  transaction_date: string;        // ISO
  amount: number;                  // absoluto
  direction: "credit" | "debit";
  description: string;
  counterparty_name: string | null;
  reference: string | null;
}

export interface CashEntryLike {
  id: string;
  type: "entrada" | "saida";
  amount: number;                  // positivo
  description: string;
  date: string;                    // ISO
  // nome do cliente/fornecedor associado (se conhecido)
  counterparty_name?: string | null;
  reference?: string | null;
}

export interface MatchResult {
  entryId: string;
  score: number;        // 0–100
  reason: string;
}

/** A direção bancária tem de bater com o tipo do lançamento. */
function directionMatches(tx: BankTxLike, entry: CashEntryLike): boolean {
  return (tx.direction === "credit" && entry.type === "entrada") ||
         (tx.direction === "debit" && entry.type === "saida");
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(Math.round((da - db) / 86400000));
}

function tokens(s: string): Set<string> {
  return new Set(
    deburr(s)
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/** Semelhança de texto 0–1 por sobreposição de tokens (Jaccard). */
function textSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Pontua um par (movimento, lançamento). Devolve null se a direção não bate ou
 * se o valor é demasiado diferente (não vale a pena sugerir).
 */
export function scoreMatch(tx: BankTxLike, entry: CashEntryLike): MatchResult | null {
  if (!directionMatches(tx, entry)) return null;

  const reasons: string[] = [];
  let score = 0;

  // ── Valor (peso máximo) ──
  const diff = Math.abs(tx.amount - entry.amount);
  const rel = entry.amount !== 0 ? diff / entry.amount : (diff === 0 ? 0 : 1);
  if (diff < 0.005) { score += 55; reasons.push("valor exato"); }
  else if (diff <= 0.05) { score += 50; reasons.push("valor igual"); }
  else if (rel <= 0.01) { score += 38; reasons.push("valor ~igual"); }
  else if (rel <= 0.05) { score += 22; reasons.push("valor aproximado"); }
  else return null; // valor demasiado diferente

  // ── Data ──
  const dd = daysBetween(tx.transaction_date, entry.date);
  if (dd === 0) { score += 25; reasons.push("mesma data"); }
  else if (dd <= 2) { score += 18; reasons.push(`${dd}d de diferença`); }
  else if (dd <= 7) { score += 10; reasons.push("data próxima"); }
  else if (dd <= 30) { score += 3; }

  // ── Descrição ──
  const descSim = textSimilarity(tx.description, entry.description);
  if (descSim >= 0.6) { score += 15; reasons.push("descrição idêntica"); }
  else if (descSim >= 0.3) { score += 9; reasons.push("descrição parecida"); }
  else if (descSim > 0) { score += 4; }

  // ── Contraparte (cliente/fornecedor) ──
  if (tx.counterparty_name && entry.counterparty_name) {
    const cpSim = textSimilarity(tx.counterparty_name, entry.counterparty_name);
    if (cpSim >= 0.5) { score += 10; reasons.push("contraparte coincide"); }
    else if (cpSim > 0) { score += 4; }
  }

  // ── Referência ──
  if (tx.reference && entry.reference) {
    const a = deburr(tx.reference).replace(/\s/g, "");
    const b = deburr(entry.reference).replace(/\s/g, "");
    if (a && b && (a === b || a.includes(b) || b.includes(a))) {
      score += 10; reasons.push("referência coincide");
    }
  }

  return {
    entryId: entry.id,
    score: Math.min(100, Math.round(score)),
    reason: reasons.join(", "),
  };
}

export interface SuggestOptions {
  minScore?: number;   // limiar mínimo para sugerir (default 50)
  maxSuggestions?: number;
}

/** Classifica a confiança textual de uma pontuação. */
export function confidenceLabel(score: number): string {
  if (score >= 90) return "muito provável";
  if (score >= 70) return "provável";
  if (score >= 50) return "possível";
  return "baixa confiança";
}

/**
 * Devolve as melhores sugestões de lançamento para um movimento bancário,
 * ordenadas por pontuação decrescente.
 */
export function suggestMatches(
  tx: BankTxLike,
  entries: CashEntryLike[],
  opts: SuggestOptions = {},
): MatchResult[] {
  const minScore = opts.minScore ?? 50;
  const max = opts.maxSuggestions ?? 3;
  const scored: MatchResult[] = [];
  for (const entry of entries) {
    const r = scoreMatch(tx, entry);
    if (r && r.score >= minScore) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
