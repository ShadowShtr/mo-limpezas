// ============================================================================
// T11 — Comparador: fórmulas antigas × modelo canónico
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Nunca liga ao Supabase, nunca lê credenciais, nunca escreve.
// Opera exclusivamente sobre fixtures sintéticas.
//
// ----------------------------------------------------------------------------
//
// Mesmo padrão da T07 (`recurrence-compat.ts`): em vez de discutir se a mudança
// é grande, mede-se. A diferença é que aqui os casos são gerados, não lidos de
// produção — o valor de uma avença e o número de ocorrências são um espaço
// pequeno e enumerável, e não é preciso tocar em dados reais para o cobrir.

import {
  type LegacyAvencaInput,
  legacyDailyBillingBase,
  legacyDailyBillingMonthTotal,
  legacyDashboardValueWithVat,
  legacyInvoiceMonthlyLine,
  legacyReportsMonthTotal,
  legacyReportsParts,
} from "./legacy-formulas";
import { type MoneyCents, eurosToCents, centsToEuros, sumCents } from "./money";
import { allocateMonthlyAmount, type AllocatableOccurrence } from "./monthly-allocation";
import { applyVat, sumVatBreakdowns, type VatBreakdown } from "./vat";

export interface AvencaCase {
  /** Rótulo do caso. Sintético — nunca um id real. */
  label: string;
  /** Valor mensal do contrato, em euros. */
  fixedPriceEuros: number | null;
  /** Nº de ocorrências elegíveis no mês. */
  occurrenceCount: number;
  applyVat: boolean;
  vatRatePct: number;
}

export interface AvencaComparison {
  label: string;
  occurrenceCount: number;
  /** Valor mensal, em cêntimos, tal como o canónico o lê. */
  totalCents: MoneyCents | null;

  /** Soma das quotas arredondadas da Cobrança Diária, em cêntimos. */
  legacyDailyTotalCents: number;
  /** Soma acumulada dos Relatórios, em cêntimos. */
  legacyReportsTotalCents: number;
  /** Linha única da fatura, em cêntimos. */
  legacyInvoiceTotalCents: number;
  /** Total com IVA do Dashboard, em cêntimos. */
  legacyDashboardGrossCents: number;

  /** Soma das alocações canónicas. Igual ao total, por construção. */
  canonicalAllocatedCents: number;
  /** Decomposição canónica do mês. */
  canonicalVat: VatBreakdown;

  /** `legacyDaily − canónico`. Negativo = a Cobrança Diária perde dinheiro. */
  dailyDriftCents: number;
  /** `legacyReports − canónico`. */
  reportsDriftCents: number;
  /** `legacyDashboardGross − canonicalGross`. */
  dashboardDriftCents: number;
  /** `legacyInvoice − canónico`. Zero: a fatura nunca dividiu. */
  invoiceDriftCents: number;

  /** Alguma das quatro divergiu do canónico. */
  changed: boolean;
  reasons: CompatReason[];
}

export type CompatReason =
  /** A soma das quotas arredondadas não dá o valor mensal. */
  | "CENTS_LOST_IN_SPLIT"
  /** Dois consumidores dão totais diferentes para o mesmo mês. */
  | "CONSUMERS_DISAGREE"
  /** O total com IVA difere por causa da ordem de arredondamento. */
  | "VAT_ROUNDING_ORDER"
  /** Valor mensal sem ocorrências: o antigo divide por 1, o canónico não aloca. */
  | "NO_OCCURRENCES_FALLBACK";

export interface AvencaCompatSummary {
  totalCases: number;
  unchanged: number;
  changed: number;
  /** Cêntimos que a Cobrança Diária perde, somados sobre todos os casos. */
  totalDailyDriftCents: number;
  totalReportsDriftCents: number;
  totalDashboardDriftCents: number;
  byReason: Record<CompatReason, number>;
  /** Pior desvio absoluto num único caso, em cêntimos. */
  worstDriftCents: number;
  worstDriftLabel: string | null;
}

export interface AvencaCompatReport {
  summary: AvencaCompatSummary;
  cases: readonly AvencaComparison[];
}

const EMPTY_BY_REASON: Record<CompatReason, number> = {
  CENTS_LOST_IN_SPLIT: 0,
  CONSUMERS_DISAGREE: 0,
  VAT_ROUNDING_ORDER: 0,
  NO_OCCURRENCES_FALLBACK: 0,
};

/** Ocorrências sintéticas, com datas civis estáveis (dia 1..N de um mês fixo). */
export function syntheticOccurrences(count: number, month = "2026-08"): AllocatableOccurrence[] {
  const out: AllocatableOccurrence[] = [];
  for (let i = 0; i < count; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    out.push({ id: `occ-${String(i).padStart(3, "0")}`, occurrenceDate: `${month}-${day}` });
  }
  return out;
}

/** Converte euros para cêntimos inteiros sem passar pelo domínio marcado. */
function toCentsRaw(euros: number): number {
  return Math.round(euros * 100);
}

export function compareAvencaCase(input: AvencaCase): AvencaComparison {
  const legacyInput: LegacyAvencaInput = {
    fixedPrice: input.fixedPriceEuros,
    count: input.occurrenceCount,
    applyVat: input.applyVat,
    vatRatePct: input.vatRatePct,
  };

  const totalCents = eurosToCents(input.fixedPriceEuros);
  const occurrences = syntheticOccurrences(input.occurrenceCount);

  // ── canónico ──────────────────────────────────────────────────────────────
  const allocation = allocateMonthlyAmount({ totalCents, occurrences });
  const canonicalAllocatedCents = allocation.allocatedCents;
  const canonicalVat = sumVatBreakdowns(
    allocation.allocations.map((a) =>
      applyVat(a.amountCents, { applyVat: input.applyVat, ratePct: input.vatRatePct }),
    ),
  );

  // ── antigo ────────────────────────────────────────────────────────────────
  const legacyDailyTotalCents = toCentsRaw(legacyDailyBillingMonthTotal(legacyInput));
  const legacyReportsTotalCents = toCentsRaw(legacyReportsMonthTotal(legacyInput));
  const legacyInvoiceTotalCents = toCentsRaw(legacyInvoiceMonthlyLine(legacyInput));
  const perServiceGross = legacyDashboardValueWithVat(legacyInput);
  const legacyDashboardGrossCents = Math.round(
    perServiceGross * Math.max(1, input.occurrenceCount) * 100,
  );

  // ── desvios ───────────────────────────────────────────────────────────────
  const dailyDriftCents = legacyDailyTotalCents - canonicalAllocatedCents;
  const reportsDriftCents = legacyReportsTotalCents - canonicalAllocatedCents;
  const invoiceDriftCents = legacyInvoiceTotalCents - canonicalAllocatedCents;
  const dashboardDriftCents = legacyDashboardGrossCents - canonicalVat.grossCents;

  const reasons: CompatReason[] = [];
  if (dailyDriftCents !== 0) reasons.push("CENTS_LOST_IN_SPLIT");
  if (legacyDailyTotalCents !== legacyReportsTotalCents) reasons.push("CONSUMERS_DISAGREE");
  if (dashboardDriftCents !== 0) reasons.push("VAT_ROUNDING_ORDER");
  if (allocation.outcome === "UNALLOCATED_NO_OCCURRENCES") {
    reasons.push("NO_OCCURRENCES_FALLBACK");
  }

  return {
    label: input.label,
    occurrenceCount: input.occurrenceCount,
    totalCents,
    legacyDailyTotalCents,
    legacyReportsTotalCents,
    legacyInvoiceTotalCents,
    legacyDashboardGrossCents,
    canonicalAllocatedCents,
    canonicalVat,
    dailyDriftCents,
    reportsDriftCents,
    dashboardDriftCents,
    invoiceDriftCents,
    changed: reasons.length > 0,
    reasons,
  };
}

export function compareAvencaCases(cases: readonly AvencaCase[]): AvencaCompatReport {
  const comparisons = cases.map(compareAvencaCase);
  const summary: AvencaCompatSummary = {
    totalCases: comparisons.length,
    unchanged: 0,
    changed: 0,
    totalDailyDriftCents: 0,
    totalReportsDriftCents: 0,
    totalDashboardDriftCents: 0,
    byReason: { ...EMPTY_BY_REASON },
    worstDriftCents: 0,
    worstDriftLabel: null,
  };

  for (const c of comparisons) {
    if (c.changed) summary.changed++;
    else summary.unchanged++;
    summary.totalDailyDriftCents += c.dailyDriftCents;
    summary.totalReportsDriftCents += c.reportsDriftCents;
    summary.totalDashboardDriftCents += c.dashboardDriftCents;
    for (const r of c.reasons) summary.byReason[r]++;

    const worst = Math.max(
      Math.abs(c.dailyDriftCents),
      Math.abs(c.reportsDriftCents),
      Math.abs(c.dashboardDriftCents),
    );
    if (worst > summary.worstDriftCents) {
      summary.worstDriftCents = worst;
      summary.worstDriftLabel = c.label;
    }
  }

  return { summary, cases: comparisons };
}

/**
 * Matriz padrão: os valores e contagens que o plano mestre exige, cruzados.
 * Determinística — a mesma matriz em qualquer máquina.
 */
export function defaultAvencaMatrix(vatRatePct = 23): AvencaCase[] {
  const amounts = [0, 0.01, 1, 10, 99.99, 100, 1000];
  const counts = [0, 1, 2, 3, 7, 11, 28, 30, 31];
  const cases: AvencaCase[] = [];
  for (const fixedPriceEuros of amounts) {
    for (const occurrenceCount of counts) {
      for (const withVat of [false, true]) {
        cases.push({
          label: `${fixedPriceEuros.toFixed(2)}€ ÷ ${occurrenceCount}${withVat ? " +IVA" : ""}`,
          fixedPriceEuros,
          occurrenceCount,
          applyVat: withVat,
          vatRatePct,
        });
      }
    }
  }
  return cases;
}

/** Euros legíveis a partir de cêntimos inteiros. Só para relatório. */
export function driftToEuros(cents: number): number {
  return centsToEuros(cents as MoneyCents) ?? 0;
}

/** Reexportado para o script não precisar de importar de dois sítios. */
export { sumCents, legacyDailyBillingBase, legacyReportsParts };
