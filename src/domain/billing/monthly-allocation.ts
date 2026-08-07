// ============================================================================
// T11 — Distribuição da avença mensal
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não conhece Supabase nem o relógio
// do sistema. Nenhuma função aqui altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// Um contrato de avença (`contracts.fixed_monthly = true`) tem um valor mensal
// e N ocorrências. O serviço em si vale 0 — a avença fatura uma vez por mês.
// Para mostrar quanto rendeu cada dia, cada ecrã dividiu o valor pelo número de
// ocorrências. E cada ecrã dividiu de forma diferente:
//
//   daily-billing.ts      round((fixed_price / count) * 100) / 100, por serviço
//   financial-dashboard   (fixed_price / count) sem arredondar, acumulado
//   reports.ts            (fixed_price / count) sem arredondar, acumulado
//   invoices.ts           NÃO divide — emite uma linha com o fixed_price inteiro
//
// Três consequências mensuráveis:
//
//   1. CÊNTIMOS PERDIDOS. 100,00 € em 3 ocorrências dá 33,33 € × 3 = 99,99 €
//      na Cobrança Diária. Falta um cêntimo, todos os meses, para sempre.
//
//   2. DENOMINADORES DIFERENTES. O `daily-billing` conta os serviços do mês com
//      uma consulta dedicada ao mês inteiro. O `financial-dashboard` conta
//      apenas os serviços que já tinha em memória — e a janela que carrega é
//      "semana ∪ mês", que numa semana a cavalo de dois meses **não cobre o mês
//      inteiro**. O mesmo serviço vale mais no dashboard do que na cobrança,
//      porque o denominador é menor.
//
//   3. REALIZADO ≠ FATURADO. Os três ecrãs dividem; a fatura não divide. Somar
//      o "realizado" do mês nunca dá o valor faturado, e nada no sistema
//      explicava porquê.
//
// Este módulo resolve (1) e (2). O (3) é uma questão de conceito, e está fixado
// em `financial-model.ts`: são grandezas diferentes e não têm de coincidir —
// o que não pode é chamar-se o mesmo nome às duas.
//
// ----------------------------------------------------------------------------
//
// O que este módulo NÃO decide.
//
// Que ocorrências entram na conta. Isso é decisão de produto (conta a agendada?
// a concluída? a cancelada com aviso?) e muda conforme o ecrã. Quem chama passa
// o conjunto já filtrado. Ver `MonthlyAllocationInput.occurrences`.

import { type CivilDate, isValidCivilDate } from "../scheduling/civil-date";
import {
  type MoneyCents,
  ZERO_CENTS,
  assertMoneyCents,
  isMoneyCents,
} from "./money";

// ─── Entrada ────────────────────────────────────────────────────────────────

/**
 * Uma ocorrência elegível. Só o que é preciso para ordenar de forma estável e
 * devolver o resultado identificável — nada de cliente, morada ou valor.
 */
export interface AllocatableOccurrence {
  /** `services.id`, ou a identidade canónica da T08. Tem de ser único. */
  id: string;
  /** Data civil da ocorrência (`occurrence_date` da T08). */
  occurrenceDate: CivilDate;
}

/**
 * Proporcionalidade de contratos que começam ou terminam a meio do mês.
 *
 * `FULL_MONTH` é o comportamento actual e o único implementado.
 * `PRORATED` está reservado, **não implementado de propósito**: a regra real
 * (por dias de calendário? por ocorrências previstas? conta o dia de início?)
 * é uma decisão de negócio que ainda não foi tomada. Inventar uma seria mudar
 * facturação real com base num palpite.
 */
export type MonthlyProrationPolicy = "FULL_MONTH" | "PRORATED";

export interface MonthlyAllocationInput {
  /** Valor mensal do contrato, em cêntimos. `null` = sem base para calcular. */
  totalCents: MoneyCents | null;
  /** Conjunto JÁ FILTRADO pelo caso de uso. Ordem irrelevante — é normalizada. */
  occurrences: readonly AllocatableOccurrence[];
  /** Omissa = `FULL_MONTH`. */
  policy?: MonthlyProrationPolicy;
}

// ─── Saída ──────────────────────────────────────────────────────────────────

export type MonthlyAllocationOutcome =
  /** Distribuído. `allocatedCents` é igual a `totalCents`. */
  | "ALLOCATED"
  /** Há valor mensal mas nenhuma ocorrência elegível. Não se divide por zero. */
  | "UNALLOCATED_NO_OCCURRENCES"
  /** Não há valor mensal (`null`). Diferente de valor zero. */
  | "UNALLOCATED_NO_AMOUNT";

export interface MonthlyAllocation {
  occurrenceId: string;
  occurrenceDate: CivilDate;
  amountCents: MoneyCents;
  /** Posição na ordem canónica, base 0. */
  index: number;
  /** `true` se esta ocorrência recebeu um cêntimo do resto da divisão. */
  carriesRemainder: boolean;
}

export interface MonthlyAllocationResult {
  outcome: MonthlyAllocationOutcome;
  totalCents: MoneyCents | null;
  allocations: readonly MonthlyAllocation[];
  /** Soma efectivamente distribuída. */
  allocatedCents: MoneyCents;
  /**
   * Valor que existe mas não foi atribuído a nenhuma ocorrência.
   *
   * Só é diferente de zero em `UNALLOCATED_NO_OCCURRENCES`. É deliberadamente
   * visível: uma avença de 300 € num mês sem serviços é dinheiro contratado que
   * o sistema **não** deve mostrar como receita realizada, mas também não deve
   * fazer desaparecer sem deixar rasto.
   */
  unallocatedCents: MoneyCents;
  occurrenceCount: number;
  policy: MonthlyProrationPolicy;
  /** Ocorrências rejeitadas por `id` repetido. Diagnóstico, não erro. */
  duplicateCount: number;
  /** Ocorrências com data inválida. Entram no fim da ordem canónica. */
  invalidDateCount: number;
}

// ─── Ordem canónica ─────────────────────────────────────────────────────────

/**
 * `occurrenceDate` e, em empate, `id`.
 *
 * Nunca `created_at`, nunca a ordem em que a consulta devolveu as linhas,
 * nunca a posição no array. Se a ordem de chegada mudar, o resto da divisão
 * mudaria de ocorrência e o mesmo mês passaria a mostrar números diferentes
 * sem nada ter mudado nos dados.
 *
 * Datas ISO comparam-se lexicograficamente, por isso `localeCompare` sobre a
 * string é suficiente e não constrói `Date` nenhum (o fuso do processo não
 * entra na conta).
 *
 * Datas inválidas vão para o fim, ordenadas entre si por `id`. Um `starts_on`
 * corrompido já aconteceu em produção (ver `safeFormat` em `src/lib/utils.ts`);
 * rebentar a alocação inteira por causa de uma linha má seria pior do que
 * alocá-la em último lugar e contá-la em `invalidDateCount`.
 */
export function compareOccurrences(a: AllocatableOccurrence, b: AllocatableOccurrence): number {
  const aValid = isValidCivilDate(a.occurrenceDate);
  const bValid = isValidCivilDate(b.occurrenceDate);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && a.occurrenceDate !== b.occurrenceDate) {
    return a.occurrenceDate < b.occurrenceDate ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Ordem canónica + remoção de `id` repetido (fica a primeira aparição na ordem
 * canónica, não a primeira do array de entrada — senão a ordem de chegada
 * voltava a influenciar o resultado).
 */
export function canonicalOrder(
  occurrences: readonly AllocatableOccurrence[],
): { ordered: AllocatableOccurrence[]; duplicateCount: number; invalidDateCount: number } {
  const sorted = [...occurrences].sort(compareOccurrences);
  const seen = new Set<string>();
  const ordered: AllocatableOccurrence[] = [];
  let duplicateCount = 0;
  let invalidDateCount = 0;

  for (const occ of sorted) {
    if (seen.has(occ.id)) {
      duplicateCount++;
      continue;
    }
    seen.add(occ.id);
    if (!isValidCivilDate(occ.occurrenceDate)) invalidDateCount++;
    ordered.push(occ);
  }

  return { ordered, duplicateCount, invalidDateCount };
}

// ─── Distribuição ───────────────────────────────────────────────────────────

/**
 * Divide `total` por `count` sem perder um único cêntimo.
 *
 *   base      = trunc(|total| / count)
 *   resto     = |total| % count
 *   as primeiras `resto` posições da ordem canónica recebem +1 cêntimo
 *
 * 100,00 € em 3 → 33,34 / 33,33 / 33,33. Soma: 100,00 €. Exacto, por
 * construção, para qualquer total e qualquer contagem.
 *
 * O sinal é separado antes da divisão para que um estorno (-100,00 € em 3) se
 * distribua com a mesma forma: -33,34 / -33,33 / -33,33. Sem isso, `%` e
 * `Math.floor` em negativos empurrariam o resto para o lado errado.
 */
export function splitCentsEvenly(totalCents: MoneyCents, count: number): MoneyCents[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError(`splitCentsEvenly: contagem inválida (${count}).`);
  }
  assertMoneyCents(totalCents, "splitCentsEvenly.totalCents");

  const sign = totalCents < 0 ? -1 : 1;
  const magnitude = Math.abs(totalCents);
  const base = Math.trunc(magnitude / count);
  const remainder = magnitude - base * count;

  const parts: MoneyCents[] = [];
  for (let i = 0; i < count; i++) {
    const share = base + (i < remainder ? 1 : 0);
    parts.push(assertMoneyCents(sign * share, "splitCentsEvenly.share"));
  }
  return parts;
}

/**
 * Distribui o valor mensal de um contrato pelas suas ocorrências elegíveis.
 *
 * INVARIANTE, sem excepções:
 *
 *   outcome === "ALLOCATED"  ⟹  sum(allocations) === totalCents
 *
 * Determinística: as mesmas ocorrências, em qualquer ordem de chegada, dão
 * sempre exactamente o mesmo resultado.
 */
export function allocateMonthlyAmount(input: MonthlyAllocationInput): MonthlyAllocationResult {
  const policy = input.policy ?? "FULL_MONTH";

  if (policy === "PRORATED") {
    throw new Error(
      "allocateMonthlyAmount: a política PRORATED está em standby na T11. A regra de "
      + "proporcionalidade para contratos iniciados ou terminados a meio do mês é uma "
      + "decisão de negócio por tomar — ver docs/T11-modelo-financeiro-canonico.md.",
    );
  }

  const { ordered, duplicateCount, invalidDateCount } = canonicalOrder(input.occurrences);
  const count = ordered.length;

  const base = {
    totalCents: input.totalCents,
    allocations: [] as readonly MonthlyAllocation[],
    allocatedCents: ZERO_CENTS,
    occurrenceCount: count,
    policy,
    duplicateCount,
    invalidDateCount,
  };

  // Sem valor mensal: não há nada para distribuir, e isso não é zero euros.
  if (input.totalCents == null) {
    return { ...base, outcome: "UNALLOCATED_NO_AMOUNT", unallocatedCents: ZERO_CENTS };
  }
  if (!isMoneyCents(input.totalCents)) {
    throw new RangeError(
      `allocateMonthlyAmount: totalCents inválido (${input.totalCents}).`,
    );
  }

  // Valor sem ocorrências: nunca dividir por zero, nunca inventar receita.
  if (count === 0) {
    return {
      ...base,
      outcome: "UNALLOCATED_NO_OCCURRENCES",
      unallocatedCents: input.totalCents,
    };
  }

  const shares = splitCentsEvenly(input.totalCents, count);
  const magnitude = Math.abs(input.totalCents);
  const remainder = magnitude - Math.trunc(magnitude / count) * count;

  const allocations: MonthlyAllocation[] = ordered.map((occ, index) => ({
    occurrenceId: occ.id,
    occurrenceDate: occ.occurrenceDate,
    amountCents: shares[index],
    index,
    carriesRemainder: index < remainder,
  }));

  return {
    ...base,
    outcome: "ALLOCATED",
    allocations,
    allocatedCents: sumMonthlyAllocations(allocations),
    unallocatedCents: ZERO_CENTS,
  };
}

/**
 * Soma as alocações. Existe como função nomeada (e não como `reduce` inline em
 * cada consumidor) porque é a verificação da invariante, e um teste que chama a
 * mesma função que o código de produção prova mais do que um teste que
 * reimplementa a soma.
 */
export function sumMonthlyAllocations(
  allocations: readonly MonthlyAllocation[],
): MoneyCents {
  let total = 0;
  for (const a of allocations) total += a.amountCents;
  return assertMoneyCents(total, "sumMonthlyAllocations");
}

/**
 * Alocação de uma ocorrência concreta dentro de um resultado.
 * `null` se a ocorrência não é elegível — o que é informação, não erro.
 */
export function allocationFor(
  result: MonthlyAllocationResult,
  occurrenceId: string,
): MonthlyAllocation | null {
  return result.allocations.find((a) => a.occurrenceId === occurrenceId) ?? null;
}
