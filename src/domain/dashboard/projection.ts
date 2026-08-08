// ============================================================================
// T15 — Projeção anual
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não lê o relógio, não altera dados.
//
// ----------------------------------------------------------------------------
//
// A fórmula actual, decomposta.
//
// `src/app/actions/financial-dashboard.ts` (~linha 320):
//
//     const monthsWithRevenue = yearMonths.filter(
//       (m) => m.revenue > 0 && m.month < currentMonth
//     );
//     const avgMonthlyRevenue = monthsWithRevenue.length > 0
//       ? yearRevenue / monthsWithRevenue.length      ← NUMERADOR ≠ DENOMINADOR
//       : 0;
//     const remainingMonths = 12 - currentMonth;
//     projected = yearRevenue + avgMonthlyRevenue * remainingMonths;
//
// **O numerador e o denominador não falam do mesmo conjunto.**
//
//   numerador   = `yearRevenue` — TODOS os meses do ano, incluindo o mês
//                 corrente, que está a meio;
//   denominador = número de meses ANTERIORES ao corrente **que tiveram receita**.
//
// Três consequências, todas na mesma direcção (sobrestimar):
//
//   1. **O mês corrente entra no numerador e não no denominador.** Uma média
//      que inclui parte de um mês incompleto no total mas não o conta como mês.
//
//   2. **Meses a zero são excluídos do denominador.** Um ano com Janeiro a 0 €
//      e Fevereiro a 1000 € dá média 1000 €, não 500 €. Um mês sem faturação é
//      um facto do negócio, não uma observação em falta.
//
//   3. **`remainingMonths = 12 − currentMonth`** trata o mês corrente como já
//      terminado. Em Março, sobram 9 meses — mas Março ainda vai a meio, e a
//      parte que falta não é projectada por ninguém.
//
// Exemplo aritmético (Jan 1000 €, Fev 1000 €, Mar corrente 200 € até agora):
//
//     yearRevenue        = 2200
//     monthsWithRevenue  = [Jan, Fev] → 2
//     avgMonthlyRevenue  = 2200 / 2 = 1100      ← nenhum mês rendeu 1100 €
//     remainingMonths    = 12 − 3 = 9
//     projected          = 2200 + 9900 = 12 100 €
//
// Uma projecção linear coerente sobre meses completos daria
// `1000 × 12 = 12 000 €`. A diferença não é arredondamento: é o método.
//
// ----------------------------------------------------------------------------
//
// O que a T15 faz e o que NÃO faz.
//
// **Não corrige por palpite.** Qual é a projecção *certa* é decisão de negócio:
// média de meses completos? extrapolação do mês corrente pelos dias decorridos?
// só contratos activos? sazonalidade? Nenhuma dessas regras está escrita em
// lado nenhum, e escolher uma aqui seria pôr um número novo num cartão sem
// ninguém ter decidido o que ele significa.
//
// O que se faz:
//
//   • `LEGACY_AVERAGE_OF_NONZERO_MONTHS` — réplica exacta da fórmula actual,
//     para o comparador poder medir a diferença;
//   • `LINEAR_BY_COMPLETED_MONTHS` — variante canónica **claramente marcada**,
//     com numerador e denominador do mesmo conjunto;
//   • `LINEAR_BY_CALENDAR_DAY` — extrapolação pelos dias civis decorridos;
//   • `SERVICE_BASED` — **STANDBY, lança**. Depende de decidir se se projecta
//     por contratos activos, por ocorrências previstas ou por histórico.
//
// Qual delas o produto usa **fica por decidir**. Ver §17 do documento da T15.

import {
  type MoneyCents,
  ZERO_CENTS,
  assertMoneyCents,
  multiplyCents,
  sumCents,
} from "../billing/money";

export type ProjectionMethod =
  /** A fórmula actual, tal como está. Só para comparação. */
  | "LEGACY_AVERAGE_OF_NONZERO_MONTHS"
  /** Média sobre meses COMPLETOS (numerador e denominador do mesmo conjunto). */
  | "LINEAR_BY_COMPLETED_MONTHS"
  /** Extrapolação pelos dias civis decorridos no ano. */
  | "LINEAR_BY_CALENDAR_DAY"
  /** Reservado. Não implementado de propósito. */
  | "SERVICE_BASED";

export type ProjectionOutcome =
  /** Há projecção. `projectedCents` está definido. */
  | "PROJECTED"
  /** Não há base suficiente (nenhum mês completo, zero dias decorridos). */
  | "INSUFFICIENT_BASIS"
  /** O método pedido está em standby. */
  | "METHOD_IN_STANDBY";

export interface ProjectionInput {
  /**
   * Valor de cada mês do ano até agora, do mês 1 ao mês corrente inclusive.
   * `null` num mês = fonte indisponível (≠ zero euros).
   */
  monthlyCents: readonly (MoneyCents | null)[];
  /** Mês corrente, 1–12. É o último elemento de `monthlyCents`. */
  currentMonth: number;
  /** Dias do ano já decorridos, contando hoje. */
  elapsedDaysInYear: number;
  /** Dias totais do ano (365 ou 366). */
  totalDaysInYear: number;
  method: ProjectionMethod;
}

export interface ProjectionResult {
  outcome: ProjectionOutcome;
  method: ProjectionMethod;
  /** `null` salvo em `PROJECTED`. Nunca zero como substituto de "não sei". */
  projectedCents: MoneyCents | null;
  /** Valor já observado no ano. Sempre presente quando há dados. */
  observedCents: MoneyCents | null;
  /** O denominador efectivamente usado. Exposto para a UI poder explicá-lo. */
  basisCount: number;
  /** Descrição do denominador, em texto técnico. */
  basisLabel: string;
  /** `true` se algum mês tinha fonte indisponível. */
  partial: boolean;
}

function observedOf(monthlyCents: readonly (MoneyCents | null)[]): {
  total: MoneyCents;
  partial: boolean;
} {
  const known: MoneyCents[] = [];
  let partial = false;
  for (const m of monthlyCents) {
    if (m == null) partial = true;
    else known.push(m);
  }
  return { total: known.length > 0 ? sumCents(known) : ZERO_CENTS, partial };
}

/**
 * Réplica exacta da fórmula actual — **incluindo os seus defeitos**.
 *
 * Existe para o comparador. Não usar em produção.
 */
function legacyProjection(input: ProjectionInput): ProjectionResult {
  const { total: observed, partial } = observedOf(input.monthlyCents);

  // Meses ANTERIORES ao corrente com valor > 0.
  let nonZeroBefore = 0;
  for (let i = 0; i < input.monthlyCents.length; i++) {
    const month = i + 1;
    const value = input.monthlyCents[i];
    if (month >= input.currentMonth) continue;
    if (value != null && value > 0) nonZeroBefore += 1;
  }

  if (nonZeroBefore === 0) {
    // O original devolve `avg = 0` e portanto `projected = yearRevenue`.
    return {
      outcome: "PROJECTED",
      method: "LEGACY_AVERAGE_OF_NONZERO_MONTHS",
      projectedCents: observed,
      observedCents: observed,
      basisCount: 0,
      basisLabel: "nenhum mês anterior com receita — média zero (comportamento actual)",
      partial,
    };
  }

  // O defeito: `observed` cobre todos os meses (incluindo o corrente,
  // incompleto), mas o denominador só conta os anteriores com valor.
  const avg = observed / nonZeroBefore;
  const remaining = 12 - input.currentMonth;
  const projected = Math.round(observed + avg * remaining);

  return {
    outcome: "PROJECTED",
    method: "LEGACY_AVERAGE_OF_NONZERO_MONTHS",
    projectedCents: assertMoneyCents(projected, "legacyProjection"),
    observedCents: observed,
    basisCount: nonZeroBefore,
    basisLabel:
      "total do ano ÷ meses ANTERIORES com receita > 0 (numerador e denominador "
      + "de conjuntos diferentes)",
    partial,
  };
}

/**
 * Média sobre meses **completos**, incluindo os que renderam zero.
 *
 * Numerador e denominador falam do mesmo conjunto: os meses 1 a
 * `currentMonth − 1`. O mês corrente fica de fora dos dois lados, e o que já
 * rendeu é somado no fim como valor observado.
 *
 * `projected = observado + média_dos_meses_completos × meses_que_faltam`,
 * onde `meses_que_faltam = 12 − currentMonth` (o corrente já está em
 * `observado`, ainda que parcial).
 */
function linearByCompletedMonths(input: ProjectionInput): ProjectionResult {
  const { total: observed, partial } = observedOf(input.monthlyCents);

  const completed: MoneyCents[] = [];
  let missing = false;
  for (let i = 0; i < input.monthlyCents.length; i++) {
    const month = i + 1;
    if (month >= input.currentMonth) continue;
    const value = input.monthlyCents[i];
    if (value == null) { missing = true; continue; }
    completed.push(value);
  }

  if (completed.length === 0) {
    return {
      outcome: "INSUFFICIENT_BASIS",
      method: "LINEAR_BY_COMPLETED_MONTHS",
      projectedCents: null,
      observedCents: observed,
      basisCount: 0,
      basisLabel: "nenhum mês completo no ano — sem base para extrapolar",
      partial: partial || missing,
    };
  }

  const avg = sumCents(completed) / completed.length;
  const remaining = Math.max(0, 12 - input.currentMonth);
  const projected = Math.round(observed + avg * remaining);

  return {
    outcome: "PROJECTED",
    method: "LINEAR_BY_COMPLETED_MONTHS",
    projectedCents: assertMoneyCents(projected, "linearByCompletedMonths"),
    observedCents: observed,
    basisCount: completed.length,
    basisLabel: `média de ${completed.length} mês(es) completo(s), zeros incluídos`,
    partial: partial || missing,
  };
}

/**
 * Extrapolação pelos dias civis decorridos.
 *
 *     projected = observado × (dias_do_ano / dias_decorridos)
 *
 * Dias **civis**, não úteis: o negócio tem serviços ao sábado e a definição de
 * "dia útil" nesta empresa não está escrita em lado nenhum. Assumir Seg–Sex
 * seria inventar regra de negócio.
 */
function linearByCalendarDay(input: ProjectionInput): ProjectionResult {
  const { total: observed, partial } = observedOf(input.monthlyCents);

  if (
    !Number.isInteger(input.elapsedDaysInYear)
    || input.elapsedDaysInYear <= 0
    || !Number.isInteger(input.totalDaysInYear)
    || input.totalDaysInYear <= 0
  ) {
    return {
      outcome: "INSUFFICIENT_BASIS",
      method: "LINEAR_BY_CALENDAR_DAY",
      projectedCents: null,
      observedCents: observed,
      basisCount: 0,
      basisLabel: "dias decorridos inválidos",
      partial,
    };
  }

  return {
    outcome: "PROJECTED",
    method: "LINEAR_BY_CALENDAR_DAY",
    projectedCents: multiplyCents(observed, input.totalDaysInYear / input.elapsedDaysInYear),
    observedCents: observed,
    basisCount: input.elapsedDaysInYear,
    basisLabel: `${input.elapsedDaysInYear} de ${input.totalDaysInYear} dias civis decorridos`,
    partial,
  };
}

/**
 * Ponto de entrada único.
 *
 * `SERVICE_BASED` devolve `METHOD_IN_STANDBY` em vez de lançar: uma projecção é
 * um cartão informativo, e rebentar o dashboard inteiro por causa dele seria
 * pior do que mostrar "método não definido". (Contraste com `PRORATED` na T11,
 * que **lança** — lá o valor entra em facturação real.)
 */
export function projectAnnual(input: ProjectionInput): ProjectionResult {
  switch (input.method) {
    case "LEGACY_AVERAGE_OF_NONZERO_MONTHS":
      return legacyProjection(input);
    case "LINEAR_BY_COMPLETED_MONTHS":
      return linearByCompletedMonths(input);
    case "LINEAR_BY_CALENDAR_DAY":
      return linearByCalendarDay(input);
    case "SERVICE_BASED":
      return {
        outcome: "METHOD_IN_STANDBY",
        method: "SERVICE_BASED",
        projectedCents: null,
        observedCents: observedOf(input.monthlyCents).total,
        basisCount: 0,
        basisLabel:
          "SERVICE_BASED está em standby: falta decidir se se projecta por contratos "
          + "activos, por ocorrências previstas ou por histórico de serviços. "
          + "Ver docs/T15-dashboard-financeiro-canonico.md §17.",
        partial: observedOf(input.monthlyCents).partial,
      };
  }
}

/**
 * O método que o produto usa hoje.
 *
 * Fica **explicitamente** apontado ao legado enquanto ninguém decidir. Mudá-lo
 * altera um número visível no dashboard, e essa é uma decisão de produto, não
 * de refactor.
 */
export const CURRENT_PROJECTION_METHOD: ProjectionMethod = "LEGACY_AVERAGE_OF_NONZERO_MONTHS";
