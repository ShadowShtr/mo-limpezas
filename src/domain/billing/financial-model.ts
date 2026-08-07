// ============================================================================
// T11 — Modelo financeiro canónico
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não conhece Supabase.
// Constrói DTOs a partir de dados já carregados. Nada aqui altera persistência.
//
// ----------------------------------------------------------------------------
//
// O problema de vocabulário.
//
// O sistema tem hoje pelo menos quatro palavras a designar coisas diferentes
// conforme o ecrã:
//
//   "Recebido" na Cobrança Diária   → serviços com `payment_status = 'pago_total'`
//   "Recebido" no Dashboard         → faturas com `status = 'paga'`
//   "Receita" nos Relatórios        → soma dos serviços concluídos (nem faturados)
//   "done" no resumo operacional    → valor dos serviços concluídos, com IVA
//
// Nenhuma destas quatro é errada em si. O erro é chamarem-se todas o mesmo, o
// que faz com que dois ecrãs mostrem números diferentes e ninguém saiba qual
// acreditar. A T11 fixa nove conceitos, cada um com uma fonte declarada.
//
// A regra que fecha a ambiguidade:
//
//   REALIZADO  ≠  FATURADO  ≠  RECEBIDO
//
// Um serviço concluído gera REALIZADO. Só passa a FATURADO quando entra numa
// linha de fatura. Só passa a RECEBIDO quando o dinheiro é reconhecido em
// caixa. Para uma avença, o REALIZADO do mês é distribuído pelas ocorrências
// (ver `monthly-allocation.ts`) e o FATURADO é uma linha única — as duas
// grandezas coincidem em valor mensal mas **não** têm de coincidir num dia.

import { type CivilDate } from "../scheduling/civil-date";
import {
  type MoneyCents,
  ZERO_CENTS,
  assertMoneyCents,
  subtractCents,
} from "./money";
import { type VatBreakdown, sumVatBreakdowns } from "./vat";

// ─── Proveniência ───────────────────────────────────────────────────────────

/**
 * De onde veio o número. Guardado no DTO para que a UI possa dizer "isto vem
 * das faturas" em vez de mostrar um total sem explicação, e para que dois
 * valores com origens diferentes nunca sejam somados por engano.
 */
export type FinancialOrigin =
  /** `contracts` — o que foi acordado. */
  | "contract"
  /** `services` agendados (qualquer estado não cancelado). */
  | "service_scheduled"
  /** `services` concluídos. */
  | "service_completed"
  /** `invoices` / `invoice_items`. */
  | "invoice"
  /** `cash_flow_entries` — dinheiro reconhecido. */
  | "cash_flow"
  /** `payroll_records`. */
  | "payroll"
  /** Calculado a partir de outros campos deste mesmo DTO. */
  | "derived";

/**
 * Se o número está completo. Existe porque "0 €" e "não sabemos" apareciam
 * ambos como 0 e eram indistinguíveis na UI.
 */
export type Completeness =
  /** Todas as fontes necessárias foram carregadas. */
  | "COMPLETE"
  /** Faltou parte da fonte (janela truncada, contrato sem valor, etc.). */
  | "PARTIAL"
  /** Não há base para calcular. `cents` é `null`. */
  | "UNAVAILABLE";

/**
 * Um montante com contexto. Nunca um `number` solto: foi a falta de contexto
 * que permitiu somar realizado com faturado.
 */
export interface FinancialAmount {
  /** `null` quando `completeness === "UNAVAILABLE"`. Nunca 0 nesse caso. */
  cents: MoneyCents | null;
  origin: FinancialOrigin;
  completeness: Completeness;
  /** Porque é que está `PARTIAL`/`UNAVAILABLE`. Texto técnico, não para o cliente. */
  note?: string;
}

export function amount(
  cents: MoneyCents,
  origin: FinancialOrigin,
  completeness: Completeness = "COMPLETE",
  note?: string,
): FinancialAmount {
  return { cents: assertMoneyCents(cents, "amount"), origin, completeness, note };
}

export function unavailable(origin: FinancialOrigin, note: string): FinancialAmount {
  return { cents: null, origin, completeness: "UNAVAILABLE", note };
}

/** Cêntimos de um montante, tratando `UNAVAILABLE` como zero para agregação. */
export function centsOrZero(a: FinancialAmount): MoneyCents {
  return a.cents ?? ZERO_CENTS;
}

/** A completude mais fraca de um conjunto — usada ao derivar. */
export function weakestCompleteness(parts: readonly FinancialAmount[]): Completeness {
  if (parts.some((p) => p.completeness === "UNAVAILABLE")) return "UNAVAILABLE";
  if (parts.some((p) => p.completeness === "PARTIAL")) return "PARTIAL";
  return "COMPLETE";
}

// ─── Os nove conceitos ──────────────────────────────────────────────────────

export interface CanonicalFinancialSummary {
  /** Valor previsto pelo contrato para o período. Fonte: `contracts`. */
  contracted: FinancialAmount;
  /** Valor das ocorrências planeadas. Fonte: `services` não cancelados. */
  scheduled: FinancialAmount;
  /** Valor do trabalho efectivamente realizado. Fonte: `services` concluídos. */
  performed: FinancialAmount;
  /** Valor emitido em faturas. Fonte: `invoices`. */
  invoiced: FinancialAmount;
  /** Dinheiro reconhecido como recebido. Fonte: caixa/faturas pagas. */
  received: FinancialAmount;
  /** `invoiced − received`. Derivado. */
  outstanding: FinancialAmount;
  /** Parte do `outstanding` cujo vencimento já passou. */
  overdue: FinancialAmount;
  /** Despesa e folha reconhecidas. */
  cost: FinancialAmount;
  /** Receita definida − custos definidos. Derivado. */
  margin: FinancialAmount;
}

/**
 * Qual das grandezas conta como "receita" ao calcular a margem.
 *
 * Explícito porque a escolha muda o número e cada ecrã tinha feito a sua em
 * silêncio: o dashboard usava faturado, os relatórios usavam realizado.
 */
export type MarginBasis = "performed" | "invoiced" | "received";

/**
 * `invoiced − received`. Nunca o contrário, nunca "faturas com estado pendente"
 * — um valor parcialmente recebido tem de aparecer parcialmente em aberto.
 */
export function computeOutstanding(
  invoiced: FinancialAmount,
  received: FinancialAmount,
): FinancialAmount {
  const completeness = weakestCompleteness([invoiced, received]);
  if (completeness === "UNAVAILABLE") {
    return unavailable("derived", "faturado ou recebido indisponível");
  }
  return {
    cents: subtractCents(centsOrZero(invoiced), centsOrZero(received)),
    origin: "derived",
    completeness,
    note: "faturado − recebido",
  };
}

/** Receita (segundo a base escolhida) − custos. */
export function computeMargin(
  summary: Pick<CanonicalFinancialSummary, MarginBasis | "cost">,
  basis: MarginBasis,
): FinancialAmount {
  const revenue = summary[basis];
  const completeness = weakestCompleteness([revenue, summary.cost]);
  if (completeness === "UNAVAILABLE") {
    return unavailable("derived", `margem indisponível (base: ${basis})`);
  }
  return {
    cents: subtractCents(centsOrZero(revenue), centsOrZero(summary.cost)),
    origin: "derived",
    completeness,
    note: `${basis} − custos`,
  };
}

/**
 * Constrói o resumo com `outstanding` e `margin` já derivados, para que nenhum
 * consumidor os calcule à mão (foi assim que apareceram versões diferentes).
 */
export function buildSummary(
  parts: Omit<CanonicalFinancialSummary, "outstanding" | "margin">,
  marginBasis: MarginBasis = "invoiced",
): CanonicalFinancialSummary {
  const outstanding = computeOutstanding(parts.invoiced, parts.received);
  const margin = computeMargin(parts, marginBasis);
  return { ...parts, outstanding, margin };
}

/** Resumo vazio, com tudo declarado indisponível. Ponto de partida seguro. */
export function emptySummary(note = "sem dados carregados"): CanonicalFinancialSummary {
  return buildSummary({
    contracted: unavailable("contract", note),
    scheduled: unavailable("service_scheduled", note),
    performed: unavailable("service_completed", note),
    invoiced: unavailable("invoice", note),
    received: unavailable("cash_flow", note),
    overdue: unavailable("invoice", note),
    cost: unavailable("payroll", note),
  });
}

// ─── Read model para a UI ───────────────────────────────────────────────────

/**
 * O que a futura UI do Financeiro recebe.
 *
 * REGRA: a UI **não** calcula dinheiro. Não divide, não multiplica por 1,23,
 * não arredonda. Recebe cêntimos já decididos e formata. Qualquer componente
 * que precise de um número que não esteja aqui é sinal de que falta um campo
 * neste contrato — não de que o componente deve fazer a conta.
 */
export interface FinancialPeriod {
  /** Rótulo estável para o eixo (ex.: "2026-08"). Não é para apresentação. */
  key: string;
  start: CivilDate;
  end: CivilDate;
  summary: CanonicalFinancialSummary;
}

export interface FinancialReadModel {
  /** Agregado do período principal. */
  summary: CanonicalFinancialSummary;
  /** Séries (meses, semanas, dias) já agregadas. */
  periods: readonly FinancialPeriod[];
  /** Decomposição de IVA do período principal, para o rodapé fiscal. */
  vat: VatBreakdown;
  /** Taxa em vigor, só para rotular a UI. Nunca para recalcular. */
  vatRatePct: number;
  /** Que grandeza foi usada como receita na margem. */
  marginBasis: MarginBasis;
}

/**
 * Agrega períodos num resumo único.
 *
 * `outstanding` e `margin` são recalculados a partir dos agregados em vez de
 * somados: somar diferenças já calculadas propaga qualquer `PARTIAL` de forma
 * errada e pode dar um total que não bate com as parcelas apresentadas.
 */
export function aggregatePeriods(
  periods: readonly FinancialPeriod[],
  marginBasis: MarginBasis = "invoiced",
): CanonicalFinancialSummary {
  if (periods.length === 0) return emptySummary("nenhum período");

  const pick = (
    selector: (s: CanonicalFinancialSummary) => FinancialAmount,
    origin: FinancialOrigin,
  ): FinancialAmount => {
    const parts = periods.map((p) => selector(p.summary));
    const completeness = weakestCompleteness(parts);
    if (completeness === "UNAVAILABLE") {
      return unavailable(origin, "pelo menos um período sem dados");
    }
    let total = 0;
    for (const p of parts) total += centsOrZero(p);
    return {
      cents: assertMoneyCents(total, "aggregatePeriods"),
      origin,
      completeness,
    };
  };

  return buildSummary(
    {
      contracted: pick((s) => s.contracted, "contract"),
      scheduled: pick((s) => s.scheduled, "service_scheduled"),
      performed: pick((s) => s.performed, "service_completed"),
      invoiced: pick((s) => s.invoiced, "invoice"),
      received: pick((s) => s.received, "cash_flow"),
      overdue: pick((s) => s.overdue, "invoice"),
      cost: pick((s) => s.cost, "payroll"),
    },
    marginBasis,
  );
}

/** Decomposição de IVA agregada de várias linhas. Reexportado por conveniência. */
export function aggregateVat(parts: readonly VatBreakdown[]): VatBreakdown {
  return sumVatBreakdowns(parts);
}
