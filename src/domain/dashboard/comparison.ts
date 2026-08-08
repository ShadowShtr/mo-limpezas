// ============================================================================
// T15 — Comparação entre períodos
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não altera dados.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// A variação percentual é uma divisão, e uma divisão tem um denominador que
// pode ser zero. O dashboard actual trata isso assim:
//
//     const pct = m.revenue > 0 ? Math.round((m.margin / m.revenue) * 100) : 0;
//
// — devolve **0%** quando não há receita. Mas um mês com 0 € de receita e
// 3000 € de custos tem margem de −3000 €, e a tabela mostra "0%" ao lado de
// "−3000,00 €". O 0% não é a percentagem: é a ausência dela, disfarçada.
//
// O mesmo vale para "cresceu quanto face ao mês passado". Se o mês passado foi
// zero e este foi 1000 €, a resposta não é "+∞%" nem "+100%": é que **não há
// termo de comparação**. Qualquer número inventado ali vai parar a um cartão
// com uma seta verde.
//
// A T15 torna isso um tipo. Quem consome tem de decidir o que mostrar em cada
// caso, e não pode receber um `NaN` por engano.

import { type MoneyCents, subtractCents } from "../billing/money";
import { type FinancialAmount } from "../billing/financial-model";

/**
 * O resultado de uma variação percentual.
 *
 *   `VALUE`           — há percentagem, está em `percent`.
 *   `NOT_COMPARABLE`  — a base era zero e o valor actual não. Crescer de 0 para
 *                       1000 € não é "+100%" nem "+∞%": não há base.
 *   `UNCHANGED_ZERO`  — ambos zero. Não é 0% de crescimento sobre nada; é
 *                       "não houve nada em nenhum dos dois". Distinto de uma
 *                       variação de 0% sobre uma base real.
 *   `UNAVAILABLE`     — falta pelo menos um dos lados (fonte que falhou).
 */
export type PercentDeltaKind = "VALUE" | "NOT_COMPARABLE" | "UNCHANGED_ZERO" | "UNAVAILABLE";

export interface PercentDelta {
  kind: PercentDeltaKind;
  /** Só definido quando `kind === "VALUE"`. Nunca `NaN`, nunca `Infinity`. */
  percent: number | null;
}

/**
 * A política, sobre números simples. Serve tanto cêntimos como contagens — o
 * problema do denominador zero é o mesmo, e ter duas implementações seria
 * repetir o defeito que estas tasks andam a fechar.
 */
function rawPercentDelta(current: number | null, previous: number | null): PercentDelta {
  if (current == null || previous == null) {
    return { kind: "UNAVAILABLE", percent: null };
  }
  if (previous === 0) {
    if (current === 0) return { kind: "UNCHANGED_ZERO", percent: null };
    return { kind: "NOT_COMPARABLE", percent: null };
  }
  // `Math.abs` no denominador para que uma base negativa (estorno, margem
  // negativa) não inverta o sinal da variação.
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(pct)) return { kind: "UNAVAILABLE", percent: null };
  return { kind: "VALUE", percent: Math.round(pct * 10) / 10 };
}

export function percentDelta(
  currentCents: MoneyCents | null,
  previousCents: MoneyCents | null,
): PercentDelta {
  return rawPercentDelta(currentCents, previousCents);
}

/**
 * Uma razão entre duas grandezas (margem / receita, concluídos / agendados).
 *
 * Mesma política do `percentDelta`, aplicada ao caso "qual a percentagem de A
 * em B". É esta que substitui o `revenue > 0 ? … : 0` da tabela mensal.
 */
export function percentOf(
  partCents: MoneyCents | null,
  wholeCents: MoneyCents | null,
): PercentDelta {
  if (partCents == null || wholeCents == null) {
    return { kind: "UNAVAILABLE", percent: null };
  }
  if (wholeCents === 0) {
    if (partCents === 0) return { kind: "UNCHANGED_ZERO", percent: null };
    // Margem negativa sobre receita zero: não e 0%, e incomparavel.
    return { kind: "NOT_COMPARABLE", percent: null };
  }
  const pct = (partCents / Math.abs(wholeCents)) * 100;
  if (!Number.isFinite(pct)) return { kind: "UNAVAILABLE", percent: null };
  return { kind: "VALUE", percent: Math.round(pct * 10) / 10 };
}

/** Direcção da variação, para a seta do cartão. */
export type TrendDirection = "up" | "down" | "flat" | "unknown";

export function trendOf(absoluteDeltaCents: MoneyCents | null): TrendDirection {
  if (absoluteDeltaCents == null) return "unknown";
  if (absoluteDeltaCents > 0) return "up";
  if (absoluteDeltaCents < 0) return "down";
  return "flat";
}

/** Comparação completa entre dois períodos, para um conceito. */
export interface PeriodComparison {
  currentCents: MoneyCents | null;
  previousCents: MoneyCents | null;
  /** `current − previous`. `null` se algum dos lados falta. */
  absoluteDeltaCents: MoneyCents | null;
  percent: PercentDelta;
  trend: TrendDirection;
  /**
   * `true` quando o conceito **não é aditivo** e a comparação é entre saldos
   * (contratado, folha, vencido). A UI deve dizê-lo — comparar dois saldos não
   * é o mesmo que comparar dois fluxos.
   */
  snapshot: boolean;
}

export function compareAmounts(
  current: FinancialAmount,
  previous: FinancialAmount,
  options: { snapshot?: boolean } = {},
): PeriodComparison {
  const currentCents = current.completeness === "UNAVAILABLE" ? null : current.cents;
  const previousCents = previous.completeness === "UNAVAILABLE" ? null : previous.cents;

  const absoluteDeltaCents =
    currentCents == null || previousCents == null
      ? null
      : subtractCents(currentCents, previousCents);

  return {
    currentCents,
    previousCents,
    absoluteDeltaCents,
    percent: percentDelta(currentCents, previousCents),
    trend: trendOf(absoluteDeltaCents),
    snapshot: options.snapshot === true,
  };
}

/** Comparação de contagens (serviços, faltas). Mesma política do dinheiro. */
export interface CountComparison {
  current: number;
  previous: number;
  absoluteDelta: number;
  percent: PercentDelta;
  trend: TrendDirection;
}

export function compareCounts(current: number, previous: number): CountComparison {
  const delta = current - previous;
  return {
    current,
    previous,
    absoluteDelta: delta,
    percent: rawPercentDelta(current, previous),
    trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  };
}

/** Comparação neutra, para quando não há período anterior carregado. */
export function unavailableComparison(snapshot = false): PeriodComparison {
  return {
    currentCents: null,
    previousCents: null,
    absoluteDeltaCents: null,
    percent: { kind: "UNAVAILABLE", percent: null },
    trend: "unknown",
    snapshot,
  };
}
