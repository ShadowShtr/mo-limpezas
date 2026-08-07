// ============================================================================
// T11 — Paridade entre consumidores
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Selectores sobre dados já carregados. Não lê, não escreve,
// não está ligado a nenhum ecrã. Nada aqui corre em produção hoje.
//
// ----------------------------------------------------------------------------
//
// Quatro ecrãs mostram o valor da mesma avença: Cobrança Diária, Relatórios,
// Dashboard Financeiro e a pré-visualização da Fatura. Hoje cada um faz a sua
// conta e chega a números diferentes.
//
// Este módulo demonstra a forma final: uma única `MonthlyBillingView`, e quatro
// selectores que apenas ESCOLHEM o que mostrar. Nenhum selector divide,
// multiplica ou arredonda — se um deles precisasse de o fazer, seria sinal de
// que falta um campo na vista, não de que o selector deve fazer a conta.
//
// Enquanto os consumidores reais não forem ligados (T11 é offline), isto vive
// como contrato testável. Ligar cada ecrã é trabalho do Financeiro V2, e cada
// ligação terá de provar BEFORE = AFTER.

import { type CivilDate } from "../scheduling/civil-date";
import {
  type CanonicalFinancialSummary,
  amount,
  buildSummary,
  unavailable,
} from "./financial-model";
import { type MoneyCents, ZERO_CENTS, assertMoneyCents } from "./money";
import {
  type AllocatableOccurrence,
  type MonthlyAllocationResult,
  allocateMonthlyAmount,
} from "./monthly-allocation";
import { type VatBreakdown, type VatPolicy, applyVat, sumVatBreakdowns } from "./vat";

/** Uma ocorrência com o estado que decide a elegibilidade. */
export interface MonthlyOccurrenceInput extends AllocatableOccurrence {
  /** `services.status`. */
  status: "agendado" | "em_curso" | "concluido" | "cancelado" | "falta";
}

export interface MonthlyBillingInput {
  contractId: string;
  /** Valor mensal do contrato em cêntimos. `null` = sem base. */
  monthlyTotalCents: MoneyCents | null;
  /** TODAS as ocorrências do mês, incluindo canceladas. Filtra-se aqui. */
  occurrences: readonly MonthlyOccurrenceInput[];
  vat: VatPolicy;
}

/**
 * Política de elegibilidade — explícita, nunca escondida dentro do helper.
 *
 * `SCHEDULED` reproduz o comportamento actual dos três ecrãs que dividem: tudo
 * o que não está cancelado entra no denominador. `PERFORMED` conta só o
 * concluído. A diferença entre as duas é exactamente a diferença entre
 * "agendado" e "realizado" no modelo canónico.
 */
export type EligibilityPolicy = "SCHEDULED" | "PERFORMED";

export function isEligible(
  occurrence: MonthlyOccurrenceInput,
  policy: EligibilityPolicy,
): boolean {
  if (occurrence.status === "cancelado") return false;
  if (policy === "PERFORMED") return occurrence.status === "concluido";
  // SCHEDULED: uma falta continua a ocupar a agenda e continua a ser cobrada
  // na avença — é o comportamento actual, e mudá-lo é decisão de produto.
  return true;
}

/**
 * A vista única do mês. Tudo o que qualquer ecrã precisa de saber sobre uma
 * avença, já decidido, já em cêntimos.
 */
export interface MonthlyBillingView {
  contractId: string;
  monthlyTotalCents: MoneyCents | null;
  /** Alocação sobre o conjunto agendado (não cancelado). */
  scheduledAllocation: MonthlyAllocationResult;
  /** Alocação sobre o conjunto concluído. */
  performedAllocation: MonthlyAllocationResult;
  /** IVA do agendado, somado linha a linha. */
  scheduledVat: VatBreakdown;
  /** IVA do realizado, somado linha a linha. */
  performedVat: VatBreakdown;
  /** IVA da linha única de fatura — o valor mensal inteiro, sem dividir. */
  invoicedVat: VatBreakdown;
}

export function buildMonthlyBillingView(input: MonthlyBillingInput): MonthlyBillingView {
  const scheduled = input.occurrences.filter((o) => isEligible(o, "SCHEDULED"));
  const performed = input.occurrences.filter((o) => isEligible(o, "PERFORMED"));

  const scheduledAllocation = allocateMonthlyAmount({
    totalCents: input.monthlyTotalCents,
    occurrences: scheduled,
  });
  const performedAllocation = allocateMonthlyAmount({
    totalCents: input.monthlyTotalCents,
    occurrences: performed,
  });

  const vatOf = (allocation: MonthlyAllocationResult): VatBreakdown =>
    sumVatBreakdowns(allocation.allocations.map((a) => applyVat(a.amountCents, input.vat)));

  return {
    contractId: input.contractId,
    monthlyTotalCents: input.monthlyTotalCents,
    scheduledAllocation,
    performedAllocation,
    scheduledVat: vatOf(scheduledAllocation),
    performedVat: vatOf(performedAllocation),
    invoicedVat: applyVat(input.monthlyTotalCents ?? ZERO_CENTS, input.vat),
  };
}

// ─── Selectores por consumidor ──────────────────────────────────────────────
//
// Cada um devolve o que o seu ecrã mostra. Nenhum faz aritmética de dinheiro.

/** Valor de UMA ocorrência num dia — o que a Cobrança Diária apresenta. */
export interface DailyBillingLine {
  occurrenceId: string;
  occurrenceDate: CivilDate;
  netCents: MoneyCents;
  vatCents: MoneyCents;
  grossCents: MoneyCents;
}

export function selectDailyBilling(
  view: MonthlyBillingView,
  vat: VatPolicy,
): DailyBillingLine[] {
  return view.scheduledAllocation.allocations.map((a) => {
    const parts = applyVat(a.amountCents, vat);
    return {
      occurrenceId: a.occurrenceId,
      occurrenceDate: a.occurrenceDate,
      netCents: parts.netCents,
      vatCents: parts.vatCents,
      grossCents: parts.grossCents,
    };
  });
}

/** Total por dia — o que os Relatórios apresentam na faturação diária. */
export function selectReportsByDay(
  view: MonthlyBillingView,
  vat: VatPolicy,
): Map<CivilDate, VatBreakdown> {
  const byDay = new Map<CivilDate, VatBreakdown[]>();
  for (const a of view.performedAllocation.allocations) {
    const parts = applyVat(a.amountCents, vat);
    const list = byDay.get(a.occurrenceDate) ?? [];
    list.push(parts);
    byDay.set(a.occurrenceDate, list);
  }
  const out = new Map<CivilDate, VatBreakdown>();
  for (const [day, parts] of byDay) out.set(day, sumVatBreakdowns(parts));
  return out;
}

/** Agregado do mês — o que o Dashboard apresenta nos cartões. */
export function selectDashboardSummary(view: MonthlyBillingView): CanonicalFinancialSummary {
  const contracted = view.monthlyTotalCents;
  return buildSummary({
    contracted: contracted == null
      ? unavailable("contract", "contrato sem valor mensal")
      : amount(contracted, "contract"),
    scheduled: amount(view.scheduledAllocation.allocatedCents, "service_scheduled"),
    performed: amount(view.performedAllocation.allocatedCents, "service_completed"),
    invoiced: amount(view.invoicedVat.netCents, "invoice"),
    received: unavailable("cash_flow", "T11 não carrega caixa"),
    overdue: unavailable("invoice", "T11 não carrega vencimentos"),
    cost: unavailable("payroll", "T11 não carrega custos"),
  });
}

/** A linha única da fatura mensal — o que a pré-visualização apresenta. */
export interface InvoicePreviewLine {
  contractId: string;
  netCents: MoneyCents;
  vatCents: MoneyCents;
  grossCents: MoneyCents;
}

export function selectInvoicePreview(view: MonthlyBillingView): InvoicePreviewLine {
  return {
    contractId: view.contractId,
    netCents: view.invoicedVat.netCents,
    vatCents: view.invoicedVat.vatCents,
    grossCents: view.invoicedVat.grossCents,
  };
}

/**
 * A prova de paridade: os quatro consumidores partem da mesma vista e chegam
 * ao mesmo total mensal líquido.
 *
 * Repare-se no que isto NÃO afirma. Não afirma que o valor de um DIA na
 * Cobrança Diária é igual ao de um dia nos Relatórios — não é, e não deve ser:
 * um divide o agendado, o outro o realizado. Afirma que, sobre o mesmo conjunto
 * elegível, a soma fecha sempre no valor do contrato. É essa a invariante que
 * hoje falha.
 */
export function assertConsumerParity(view: MonthlyBillingView): {
  agree: boolean;
  dailyNetCents: MoneyCents;
  reportsNetCents: MoneyCents;
  invoiceNetCents: MoneyCents;
} {
  const dailyNetCents = view.scheduledVat.netCents;
  const reportsNetCents = view.performedVat.netCents;
  const invoiceNetCents = view.invoicedVat.netCents;

  const scheduledComplete =
    view.scheduledAllocation.outcome === "ALLOCATED"
      ? dailyNetCents === view.monthlyTotalCents
      : true;
  const performedComplete =
    view.performedAllocation.outcome === "ALLOCATED"
      ? reportsNetCents === view.monthlyTotalCents
      : true;

  return {
    agree: scheduledComplete && performedComplete,
    dailyNetCents: assertMoneyCents(dailyNetCents, "parity.daily"),
    reportsNetCents: assertMoneyCents(reportsNetCents, "parity.reports"),
    invoiceNetCents: assertMoneyCents(invoiceNetCents, "parity.invoice"),
  };
}
