// ============================================================================
// Período do módulo Financeiro — Financeiro V2, PR A
// ============================================================================
//
// **A URL é a fonte de verdade do período.** `?mes=YYYY-MM`.
//
// Antes disto, cada vista decidia sozinha que mês mostrar — `financeiro/page.tsx`
// fazia `new Date()` no servidor, a Folha usava outro caminho, e o Fluxo de
// Caixa outro ainda. O resultado é o que esta remodelação existe para acabar:
// o Resumo em Agosto, as Contas no mês corrente e a Folha noutro, tudo no mesmo
// ecrã, sem nada a dizer que os períodos não são o mesmo.
//
// ---------------------------------------------------------------------------
// O que este módulo NÃO faz
// ---------------------------------------------------------------------------
//
// Não calcula dinheiro, não escolhe fusos para timestamps e não substitui
// `lisbon-time.ts`. É apenas o **período visual** — que mês o utilizador está a
// ver. As consultas continuam a interpretar esse mês exactamente como já o
// faziam; este PR não muda nenhuma semântica de leitura.
//
// 🔴 Mudar de período é **read-only**. Nenhuma função daqui escreve, gera,
//    recalcula ou dispara nada. Ver `docs/FINANCEIRO-V2-PR-A-SHELL.md`.
// ============================================================================

import { todayInLisbon } from "@/lib/lisbon-time";

/** Nome do parâmetro na URL. Um só, em todo o módulo. */
export const FINANCE_PERIOD_PARAM = "mes";

export interface FinancePeriod {
  year: number;
  /** 1–12. */
  month: number;
  /** `YYYY-MM` — a forma canónica na URL. */
  key: string;
}

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
] as const;

/** Limites defensivos: um `?mes=0001-01` não deve poder gerar consultas absurdas. */
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

function build(year: number, month: number): FinancePeriod {
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` };
}

/**
 * O mês corrente em Lisboa.
 *
 * Usa `todayInLisbon()` e não `new Date()`: em produção o processo corre em UTC,
 * e na viragem do mês, em horário de verão, o dia civil de Lisboa pode já ser
 * do mês seguinte enquanto em UTC ainda é do anterior. É a mesma correcção que
 * a auditoria de fusos aplicou ao resto da aplicação.
 */
export function currentFinancePeriod(): FinancePeriod {
  const [ano, mes] = todayInLisbon().split("-");
  return build(Number(ano), Number(mes));
}

/**
 * Lê o período de um valor de query string.
 *
 * Qualquer entrada inválida — ausente, malformada, fora dos limites — devolve o
 * mês corrente. **Nunca lança e nunca escreve.** Uma URL adulterada degrada
 * para o comportamento normal, não para um erro.
 */
export function parseFinancePeriod(raw: string | string[] | undefined | null): FinancePeriod {
  const valor = Array.isArray(raw) ? raw[0] : raw;
  if (typeof valor !== "string") return currentFinancePeriod();

  const m = valor.trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return currentFinancePeriod();

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return currentFinancePeriod();
  if (month < 1 || month > 12) return currentFinancePeriod();
  if (year < MIN_YEAR || year > MAX_YEAR) return currentFinancePeriod();

  return build(year, month);
}

/** `"Agosto 2026"` — para o seletor e para os títulos. */
export function formatFinancePeriod(period: FinancePeriod): string {
  return `${MESES[period.month - 1]} ${period.year}`;
}

/** Só o nome do mês. */
export function monthName(month: number): string {
  return MESES[month - 1] ?? "";
}

/** Desloca o período em meses, para trás ou para a frente. */
export function shiftFinancePeriod(period: FinancePeriod, delta: number): FinancePeriod {
  const zeroBased = period.year * 12 + (period.month - 1) + delta;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12 + 12) % 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) return period;
  return build(year, month);
}

/**
 * Acrescenta o período a uma rota, preservando o que já lá esteja.
 *
 * É o que faz o mês sobreviver à navegação entre as sete vistas: sair do Resumo
 * em Agosto e chegar ao Fluxo de Caixa também em Agosto.
 */
export function withFinancePeriod(href: string, period: FinancePeriod): string {
  const [caminho, queryExistente = ""] = href.split("?");
  const params = new URLSearchParams(queryExistente);
  params.set(FINANCE_PERIOD_PARAM, period.key);
  return `${caminho}?${params.toString()}`;
}

/**
 * Primeiro e último dia do período, como `YYYY-MM-DD`.
 *
 * Existe para as vistas que precisam de um intervalo de datas civis. **Não**
 * converte para timestamp nem escolhe fuso — quem consulta a base continua a
 * fazê-lo como já fazia.
 */
export function financePeriodBounds(period: FinancePeriod): { start: string; end: string } {
  const ultimoDia = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const mm = String(period.month).padStart(2, "0");
  return {
    start: `${period.year}-${mm}-01`,
    end: `${period.year}-${mm}-${String(ultimoDia).padStart(2, "0")}`,
  };
}
