// ============================================================================
// CRM — os totais de um orçamento
// ============================================================================
//
// Regra pura: sem I/O, sem Supabase, sem React. É o que `src/domain` é para
// (padrão de engenharia, secção 2).
//
// 🔴 Este módulo NÃO é a autoridade sobre o total gravado. A autoridade é a
//    RPC `create_crm_quote_with_items`, que recalcula tudo no servidor —
//    aceitar totais vindos do browser deixaria um orçamento dizer 100 € numa
//    linha de 10 × 50 €.
//
//    Isto existe para a interface poder mostrar o total enquanto se escreve,
//    e a sua obrigação é dar exactamente o mesmo número que a RPC daria. Se os
//    dois divergirem, o utilizador vê um valor antes de gravar e outro depois
//    — e deixa de confiar no ecrã. `crm-quote-totals.test.ts` compara os dois
//    caminhos com os mesmos casos.
// ============================================================================

export interface QuoteLineInput {
  quantity: number;
  unitPrice: number;
}

export interface QuoteTotals {
  /** Soma das linhas, antes de desconto. */
  subtotal: number;
  /** Depois do desconto — a base sobre a qual o IVA incide. */
  base: number;
  vatAmount: number;
  total: number;
}

/** Arredonda a cêntimos, como a RPC faz com `round(..., 2)`. */
function cent(v: number): number {
  // `Number.EPSILON` corrige o caso clássico de 1.005 não arredondar para
  // cima em vírgula flutuante binária.
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Os totais de um orçamento.
 *
 * A ordem das operações é a mesma da RPC, e é o que garante que os dois
 * caminhos dão o mesmo número:
 *
 *   1. cada linha arredondada a cêntimos;
 *   2. somadas → subtotal;
 *   3. desconto aplicado ao subtotal → base, arredondada;
 *   4. IVA sobre a base, arredondado;
 *   5. total = base + IVA.
 *
 * Arredondar no fim, em vez de por passo, daria diferenças de um cêntimo em
 * orçamentos com muitas linhas.
 */
export function computeQuoteTotals(
  linhas: readonly QuoteLineInput[],
  opts: { discountPct?: number; applyVat?: boolean; vatRatePct?: number },
): QuoteTotals {
  const desconto = clampPct(opts.discountPct ?? 0);
  const taxa = opts.vatRatePct ?? 0;
  const comIva = (opts.applyVat ?? true) && taxa > 0;

  const subtotal = cent(
    linhas.reduce((soma, l) => soma + cent(seguro(l.quantity) * seguro(l.unitPrice)), 0),
  );

  const base = cent(subtotal * (1 - desconto / 100));
  const vatAmount = comIva ? cent((base * taxa) / 100) : 0;

  return { subtotal, base, vatAmount, total: cent(base + vatAmount) };
}

/** O total de uma linha, para a mostrar ao lado do que se escreve. */
export function computeLineTotal(quantity: number, unitPrice: number): number {
  return cent(seguro(quantity) * seguro(unitPrice));
}

/**
 * Um campo vazio, um texto por número, ou um `NaN` valem zero — nunca
 * propagam `NaN` para o total. Um ecrã que mostra «€ NaN» enquanto se escreve
 * é pior do que um que mostra zero.
 */
function seguro(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

export function formatEur(v: number): string {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
}
