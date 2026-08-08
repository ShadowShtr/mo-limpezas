// ============================================================================
// T14 — Read model canónico dos relatórios
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Constrói um DTO a partir de linhas JÁ CARREGADAS. Não lê a base,
// não escreve, não conhece Supabase, não lê o relógio. Nada aqui altera dados
// persistidos, e nenhuma função tem modo de escrita.
//
// ----------------------------------------------------------------------------
//
// O que este ficheiro é.
//
// A resposta única à pergunta "quanto aconteceu neste período". Hoje há quatro
// respostas diferentes — Relatórios, Cobrança Diária, Dashboard Financeiro e
// Faturação — porque cada ecrã carrega os seus dados, escolhe as suas datas,
// aplica o seu IVA e inventa o seu vocabulário. A T11 fixou o vocabulário e a
// aritmética do dinheiro; a T14 fixa a AGREGAÇÃO por período.
//
// A UI que vier a seguir não calcula nada. Recebe cêntimos já decididos.
//
// ----------------------------------------------------------------------------
//
// As três regras que este módulo impõe.
//
// 1. **Falha de fonte nunca é zero.** Uma consulta que falhou produz
//    `UNAVAILABLE` (`cents: null`) e um código em `integrityIssues`. Ver
//    `integrity.ts`.
//
// 2. **O denominador da avença vem sempre do MÊS INTEIRO.** Quem chama entrega
//    o conjunto completo de ocorrências de cada mês (`monthlyOccurrences`),
//    independentemente da janela do relatório. Sem isso, o valor por dia muda
//    conforme a janela que o ecrã escolheu — foi exactamente esse o defeito do
//    Dashboard Financeiro numa semana a cavalo de dois meses (§4.3 da T11).
//
// 3. **Mês e dia usam a MESMA fórmula.** Um relatório mensal é construído pelos
//    mesmos selectores que um diário, sobre uma janela maior. Não há um caminho
//    "mensal" com aritmética própria — foi assim que os totais deixaram de
//    fechar com a soma dos dias.

import { type CivilDate } from "../scheduling/civil-date";
import {
  type CanonicalFinancialSummary,
  type Completeness,
  type FinancialAmount,
  type MarginBasis,
  amount,
  buildSummary,
  unavailable,
} from "../billing/financial-model";
import {
  type MoneyCents,
  ZERO_CENTS,
  assertMoneyCents,
  sumCents,
} from "../billing/money";
import { type VatBreakdown, type VatPolicy, applyVat, sumVatBreakdowns } from "../billing/vat";
import {
  type MonthlyOccurrenceInput,
  buildMonthlyBillingView,
} from "../billing/consumer-parity";
import {
  type CivilPeriod,
  containsDate,
  coversWholeMonthOf,
  eachDay,
  intersectPeriods,
  isWholeMonth,
  makePeriod,
  monthsCovered,
  periodKey,
} from "./period";
import {
  type IntegrityIssue,
  type ReportCompleteness,
  type SourceOutcome,
  type SourceResult,
  computeCompleteness,
  issue,
  issuesFromOutcomes,
  loaded,
  failed,
  notRequested,
  rowsOf,
  sortIssues,
} from "./integrity";
import {
  type AbsenceInput,
  type CashFlowInput,
  type ContractInput,
  type InvoiceInput,
  type PayrollInput,
  type ServiceInput,
  type TimesheetInput,
  type VatSettingsInput,
} from "./report-sources";
import {
  type OperationalMetrics,
  buildOperationalMetrics,
  isPerformed,
  occupiesSchedule,
  sumOperationalMetrics,
} from "./operational-metrics";
import { summariseAbsences, totalAbsenceDays } from "./absence-metrics";

// ─── Entrada ────────────────────────────────────────────────────────────────

/**
 * Todas as ocorrências de um contrato de avença NUM MÊS — incluindo as que
 * estão fora da janela do relatório.
 *
 * É o que impede o denominador de encolher. Quem carrega faz UMA consulta por
 * mês tocado (não uma por serviço, ver §26 da task: nada de N+1), e entrega o
 * conjunto completo.
 */
export interface MonthlyOccurrenceSet {
  contractId: string;
  /** "YYYY-MM". */
  monthKey: string;
  occurrences: readonly MonthlyOccurrenceInput[];
}

export interface ReportSourcesInput {
  services?: SourceResult<ServiceInput>;
  contracts?: SourceResult<ContractInput>;
  invoices?: SourceResult<InvoiceInput>;
  cashFlow?: SourceResult<CashFlowInput>;
  payroll?: SourceResult<PayrollInput>;
  timesheets?: SourceResult<TimesheetInput>;
  absences?: SourceResult<AbsenceInput>;
  vat?: SourceResult<VatSettingsInput>;
}

export interface ReportInput {
  window: CivilPeriod;
  sources: ReportSourcesInput;
  /** Conjuntos mensais completos das avenças tocadas pela janela. */
  monthlyOccurrences?: readonly MonthlyOccurrenceSet[];
  /**
   * Data de referência para decidir o que está vencido. Explícita porque o
   * domínio não lê o relógio — e porque um relatório de um mês passado deve
   * poder ser reproduzido tal como era.
   */
  asOf: CivilDate;
  /** Que grandeza é "receita" no cálculo da margem. Omissa = `invoiced`. */
  marginBasis?: MarginBasis;
  /** Jornada diária para converter ausências em horas. Sem omissão. */
  absenceHoursPerDay?: number | null;
  /** Instante em que o relatório foi construído (ISO). Vem de fora. */
  generatedAt?: string;
  /**
   * `updated_at` mais recente entre as linhas carregadas, se quem carregou o
   * souber. `null` = frescura desconhecida — e é isso que se mostra, em vez de
   * fingir "tempo real".
   */
  freshestSourceAt?: string | null;
}

// ─── Saída ──────────────────────────────────────────────────────────────────

export interface ReportMetadata {
  period: CivilPeriod;
  periodKey: string;
  /** `true` se a janela é exactamente um mês civil. */
  wholeMonth: boolean;
  asOf: CivilDate;
  generatedAt: string | null;
  /** `null` quando não há forma de provar a frescura. Nunca inventar. */
  freshestSourceAt: string | null;
  completeness: ReportCompleteness;
  sources: readonly SourceOutcome[];
  integrityIssues: readonly IntegrityIssue[];
}

export interface ReportFinancials extends CanonicalFinancialSummary {
  /** Despesa reconhecida em caixa (sem folha). Parcela de `cost`. */
  expenses: FinancialAmount;
  /** Folha reconhecida. Parcela de `cost`. */
  payroll: FinancialAmount;
  /** Decomposição de IVA do realizado. Para o rodapé fiscal. */
  vat: VatBreakdown;
  /** Taxa em vigor, só para rotular. Nunca para recalcular. */
  vatRatePct: number | null;
  marginBasis: MarginBasis;
}

export interface ReportReadModel {
  financial: ReportFinancials;
  operations: OperationalMetrics;
  metadata: ReportMetadata;
}

/** Um dia da série. Mesmo DTO, janela de um dia. */
export interface DailyReportPoint {
  date: CivilDate;
  report: ReportReadModel;
}

// ─── Auxiliares ─────────────────────────────────────────────────────────────

function outcomeOf<T>(
  source: SourceOutcome["source"],
  result: SourceResult<T> | undefined,
): SourceOutcome {
  if (!result) return notRequested(source);
  return result.ok ? loaded(source) : failed(source, result.note);
}

/**
 * Estado de uma fatura que conta como emitida.
 *
 * `rascunho` fica de fora: um rascunho ainda não foi emitido ao cliente e
 * incluí-lo faria o "faturado" saltar antes de existir documento. `cancelado`
 * fica de fora pela razão óbvia. A escolha está aqui, num sítio só, em vez de
 * repetida em cada ecrã com critérios diferentes.
 */
function isIssuedInvoice(status: string): boolean {
  return status !== "cancelado" && status !== "rascunho";
}

/** `true` se a fatura já foi liquidada. */
function isPaidInvoice(status: string): boolean {
  return status === "pago";
}

function monthKeyOf(date: CivilDate): string {
  return date.slice(0, 7);
}

// ─── Avença: alocação por mês ───────────────────────────────────────────────

interface AllocationIndex {
  /** `serviceId` → fatia agendada, em cêntimos. */
  scheduled: Map<string, MoneyCents>;
  /** `serviceId` → fatia realizada, em cêntimos. */
  performed: Map<string, MoneyCents>;
  /** Contratos de avença cujo mês não foi entregue por inteiro. */
  issues: IntegrityIssue[];
  /** Valor mensal que existe mas não coube em nenhuma ocorrência. */
  unallocatedCents: MoneyCents;
}

/**
 * Constrói a alocação de todas as avenças tocadas pela janela.
 *
 * Delega inteiramente na T11 (`buildMonthlyBillingView`): não há aqui nenhuma
 * divisão, nenhum `Math.max(1, count)`, nenhum arredondamento. O que a T14
 * acrescenta é a garantia de que o conjunto sobre o qual a T11 divide é o mês
 * INTEIRO, e não o que calhou estar carregado.
 */
function buildAllocationIndex(
  monthlySets: readonly MonthlyOccurrenceSet[],
  contracts: readonly ContractInput[],
  vatOf: (contract: ContractInput) => VatPolicy,
): AllocationIndex {
  const scheduled = new Map<string, MoneyCents>();
  const performed = new Map<string, MoneyCents>();
  const issues: IntegrityIssue[] = [];
  const unallocated: MoneyCents[] = [];

  const contractById = new Map(contracts.map((c) => [c.id, c]));

  for (const set of monthlySets) {
    const contract = contractById.get(set.contractId);
    if (!contract) {
      issues.push(
        issue("MISSING_FINANCIAL_SOURCE", {
          source: "contracts",
          subject: set.contractId,
          detail: "há ocorrências mensais para um contrato que não foi carregado",
        }),
      );
      continue;
    }
    if (!contract.fixedMonthly) continue;

    const view = buildMonthlyBillingView({
      contractId: contract.id,
      monthlyTotalCents: contract.fixedPriceCents,
      occurrences: set.occurrences,
      vat: vatOf(contract),
    });

    for (const a of view.scheduledAllocation.allocations) {
      scheduled.set(a.occurrenceId, a.amountCents);
    }
    for (const a of view.performedAllocation.allocations) {
      performed.set(a.occurrenceId, a.amountCents);
    }

    if (view.scheduledAllocation.outcome === "UNALLOCATED_NO_OCCURRENCES") {
      unallocated.push(view.scheduledAllocation.unallocatedCents);
      issues.push(
        issue("UNALLOCATED_MONTHLY_AMOUNT", {
          source: "contracts",
          subject: `${contract.id}@${set.monthKey}`,
          detail:
            "avença com valor mensal e nenhuma ocorrência elegível no mês — "
            + "o valor não foi distribuído e não pode aparecer como receita realizada",
        }),
      );
    }

    // A invariante da T11: o distribuído fecha no valor do contrato.
    if (
      view.scheduledAllocation.outcome === "ALLOCATED"
      && contract.fixedPriceCents != null
      && view.scheduledAllocation.allocatedCents !== contract.fixedPriceCents
    ) {
      issues.push(
        issue("MONTHLY_ALLOCATION_MISMATCH", {
          source: "contracts",
          subject: `${contract.id}@${set.monthKey}`,
          detail:
            `distribuído ${view.scheduledAllocation.allocatedCents} cêntimos para um valor `
            + `mensal de ${contract.fixedPriceCents}`,
        }),
      );
    }

    if (view.scheduledAllocation.duplicateCount > 0) {
      issues.push(
        issue("DUPLICATE_SERVICE_ID", {
          source: "services",
          subject: `${contract.id}@${set.monthKey}`,
          detail: `${view.scheduledAllocation.duplicateCount} ocorrência(s) com id repetido no mês`,
        }),
      );
    }
  }

  return {
    scheduled,
    performed,
    issues,
    unallocatedCents: unallocated.length > 0 ? sumCents(unallocated) : ZERO_CENTS,
  };
}

// ─── Contratado ─────────────────────────────────────────────────────────────

/**
 * Valor previsto pelos contratos para a janela.
 *
 * Só contratos `ativo` cuja vigência toca a janela. Para cada mês tocado, um
 * contrato de avença contribui com o seu valor mensal **inteiro** — a política
 * `FULL_MONTH` da T11.
 *
 * Contrato que começa ou acaba a meio do mês: continua a contribuir com o mês
 * inteiro e o resultado fica `PARTIAL`, com nota. **A T14 não decide
 * proporcionalidade** — `PRORATED` está em standby na T11 por ser decisão de
 * negócio, e inventá-la aqui alteraria facturação real.
 */
function computeContracted(
  contracts: readonly ContractInput[],
  window: CivilPeriod,
  available: boolean,
): { value: FinancialAmount; issues: IntegrityIssue[] } {
  if (!available) {
    return {
      value: unavailable("contract", "contratos não carregados"),
      issues: [],
    };
  }

  const months = monthsCovered(window);
  const parts: MoneyCents[] = [];
  const issues: IntegrityIssue[] = [];
  let partial = false;
  let missingPrice = 0;

  for (const c of contracts) {
    if (c.status !== "ativo") continue;
    if (!c.fixedMonthly) continue;

    const vigency = makePeriod(c.startsOn ?? window.start, c.endsOn ?? window.end);
    if (!vigency) {
      issues.push(
        issue("INVALID_DATE_RANGE", {
          source: "contracts",
          subject: c.id,
          detail: "starts_on/ends_on inválido ou invertido",
        }),
      );
      continue;
    }

    for (const month of months) {
      const overlapWithWindow = intersectPeriods(month, window);
      if (!overlapWithWindow) continue;
      const overlapWithVigency = intersectPeriods(overlapWithWindow, vigency);
      if (!overlapWithVigency) continue;

      if (c.fixedPriceCents == null) {
        missingPrice += 1;
        continue;
      }

      parts.push(c.fixedPriceCents);

      const coversMonth =
        vigency.start <= month.start
        && vigency.end >= month.end
        && window.start <= month.start
        && window.end >= month.end;
      if (!coversMonth) {
        partial = true;
        issues.push(
          issue("PARTIAL_MONTH_WINDOW", {
            source: "contracts",
            subject: `${c.id}@${periodKey(month)}`,
            detail:
              "contrato ou janela não cobrem o mês inteiro — contabilizado o mês completo "
              + "(política FULL_MONTH; PRORATED está em standby na T11)",
          }),
        );
      }
    }
  }

  if (missingPrice > 0) {
    issues.push(
      issue("MISSING_FINANCIAL_SOURCE", {
        source: "contracts",
        detail: `${missingPrice} contrato(s) de avença ativos sem fixed_price`,
      }),
    );
  }

  const completeness: Completeness = partial || missingPrice > 0 ? "PARTIAL" : "COMPLETE";
  return {
    value: amount(
      parts.length > 0 ? sumCents(parts) : ZERO_CENTS,
      "contract",
      completeness,
      completeness === "PARTIAL" ? "mês parcialmente coberto ou contrato sem valor" : undefined,
    ),
    issues,
  };
}

// ─── Construção do relatório ────────────────────────────────────────────────

/**
 * Constrói o read model para uma janela qualquer — um dia, um mês, um intervalo
 * livre. É a mesma função para os três: é isso que garante a paridade
 * diária × mensal.
 */
export function buildReport(input: ReportInput): ReportReadModel {
  const { window, sources, asOf } = input;
  const marginBasis: MarginBasis = input.marginBasis ?? "invoiced";

  const outcomes: SourceOutcome[] = [
    outcomeOf("services", sources.services),
    outcomeOf("contracts", sources.contracts),
    outcomeOf("invoices", sources.invoices),
    outcomeOf("cash_flow_entries", sources.cashFlow),
    outcomeOf("payroll_records", sources.payroll),
    outcomeOf("timesheets", sources.timesheets),
    outcomeOf("absences", sources.absences),
    outcomeOf("company_settings", sources.vat),
  ];

  const issues: IntegrityIssue[] = issuesFromOutcomes(outcomes);

  const services = rowsOf(sources.services ?? { ok: true, rows: [] });
  const contracts = rowsOf(sources.contracts ?? { ok: true, rows: [] });
  const invoices = rowsOf(sources.invoices ?? { ok: true, rows: [] });
  const cashFlow = rowsOf(sources.cashFlow ?? { ok: true, rows: [] });
  const payroll = rowsOf(sources.payroll ?? { ok: true, rows: [] });
  const timesheets = rowsOf(sources.timesheets ?? { ok: true, rows: [] });
  const absences = rowsOf(sources.absences ?? { ok: true, rows: [] });

  const servicesOk = sources.services?.ok === true;
  const contractsOk = sources.contracts?.ok === true;
  const invoicesOk = sources.invoices?.ok === true;
  const cashOk = sources.cashFlow?.ok === true;
  const payrollOk = sources.payroll?.ok === true;
  const absencesOk = sources.absences?.ok === true;

  // ── IVA ───────────────────────────────────────────────────────────────────
  const vatRow = sources.vat?.ok === true ? sources.vat.rows[0] : undefined;
  const vatRatePct = vatRow?.ratePct ?? null;
  if (sources.vat && vatRatePct == null) {
    issues.push(
      issue("VAT_RATE_UNAVAILABLE", {
        source: "company_settings",
        detail: "taxa de IVA não disponível — nenhum valor assumido por omissão",
      }),
    );
  }
  const vatPolicyFor = (applyVatFlag: boolean): VatPolicy => ({
    applyVat: applyVatFlag && vatRatePct != null,
    ratePct: vatRatePct ?? 0,
  });

  // ── Avenças ───────────────────────────────────────────────────────────────
  const monthlySets = input.monthlyOccurrences ?? [];
  const allocation = buildAllocationIndex(monthlySets, contracts, (c) =>
    vatPolicyFor(c.applyVat),
  );
  issues.push(...allocation.issues);

  const avencaContractIds = new Set(
    contracts.filter((c) => c.fixedMonthly).map((c) => c.id),
  );
  const monthlySetKeys = new Set(monthlySets.map((s) => `${s.contractId}|${s.monthKey}`));

  // ── Serviços ──────────────────────────────────────────────────────────────
  const operationalBase = buildOperationalMetrics({
    services,
    timesheets,
    window,
    absenceDays: null,
    absenceHoursPerDay: input.absenceHoursPerDay ?? null,
  });
  const accepted = services.filter(
    (s, i, arr) => containsDate(window, s.occurrenceDate) && arr.findIndex((o) => o.id === s.id) === i,
  );

  // ── Ausências ─────────────────────────────────────────────────────────────
  const absenceSummary = summariseAbsences(absences, window);
  issues.push(...absenceSummary.issues);
  const absenceDays = absencesOk ? totalAbsenceDays(absenceSummary.contributions) : null;

  const operations: OperationalMetrics = {
    ...operationalBase,
    absenceDays,
    absenceHours: buildOperationalMetrics({
      services: [],
      timesheets: [],
      window,
      absenceDays,
      absenceHoursPerDay: input.absenceHoursPerDay ?? null,
    }).absenceHours,
  };
  issues.push(...operationalBase.issues);

  // ── Agendado e realizado ──────────────────────────────────────────────────
  const scheduledParts: VatBreakdown[] = [];
  const performedParts: VatBreakdown[] = [];
  let valueMissing = 0;
  let allocationMissing = 0;

  for (const s of accepted) {
    const isAvenca = s.contractId != null && avencaContractIds.has(s.contractId);

    if (isAvenca) {
      const setKey = `${s.contractId}|${monthKeyOf(s.occurrenceDate)}`;
      if (!monthlySetKeys.has(setKey)) {
        allocationMissing += 1;
        continue;
      }
      const contract = contracts.find((c) => c.id === s.contractId);
      const policy = vatPolicyFor(contract?.applyVat === true);
      const sched = allocation.scheduled.get(s.id);
      const perf = allocation.performed.get(s.id);
      if (sched != null) scheduledParts.push(applyVat(sched, policy));
      if (perf != null) performedParts.push(applyVat(perf, policy));
      continue;
    }

    if (s.valueCents == null) {
      valueMissing += 1;
      continue;
    }
    const policy = vatPolicyFor(s.applyVat);
    if (occupiesSchedule(s.status)) scheduledParts.push(applyVat(s.valueCents, policy));
    if (isPerformed(s.status)) performedParts.push(applyVat(s.valueCents, policy));
  }

  if (allocationMissing > 0) {
    issues.push(
      issue("PARTIAL_MONTH_WINDOW", {
        source: "services",
        detail:
          `${allocationMissing} ocorrência(s) de avença sem o conjunto mensal completo. `
          + "O denominador da avença TEM de vir do mês inteiro — sem ele o valor por dia "
          + "depende da janela que o ecrã escolheu (defeito §4.3 da T11).",
      }),
    );
  }
  if (valueMissing > 0) {
    issues.push(
      issue("MISSING_FINANCIAL_SOURCE", {
        source: "services",
        detail: `${valueMissing} serviço(s) sem valor calculado nem manual`,
      }),
    );
  }

  const scheduledVat = sumVatBreakdowns(scheduledParts);
  const performedVat = sumVatBreakdowns(performedParts);
  const servicesCompleteness: Completeness = !servicesOk
    ? "UNAVAILABLE"
    : allocationMissing > 0 || valueMissing > 0
      ? "PARTIAL"
      : "COMPLETE";

  // ── Faturado, recebido, vencido ───────────────────────────────────────────
  const issuedInvoices = invoices.filter(
    (inv) => isIssuedInvoice(inv.status) && containsDate(window, inv.periodStart),
  );

  for (const inv of issuedInvoices) {
    if (inv.itemCount === 0) {
      issues.push(
        issue("INVOICED_WITHOUT_ITEMS", {
          source: "invoices",
          subject: inv.id,
          detail: "fatura emitida sem nenhuma linha em invoice_items",
        }),
      );
    }
    if (inv.netCents + inv.vatCents !== inv.grossCents) {
      issues.push(
        issue("MONTHLY_ALLOCATION_MISMATCH", {
          source: "invoices",
          subject: inv.id,
          detail: `subtotal + IVA ≠ total (${inv.netCents} + ${inv.vatCents} ≠ ${inv.grossCents})`,
        }),
      );
    }
  }

  const invoicedCents = issuedInvoices.length > 0
    ? sumCents(issuedInvoices.map((i) => i.grossCents))
    : ZERO_CENTS;

  // Recebido = dinheiro reconhecido em CAIXA. Nunca `services.payment_status`,
  // nunca "faturas com estado pago" — são grandezas diferentes (ver T11 §4.4).
  const receivedEntries = cashFlow.filter(
    (e) => e.type === "entrada" && e.status === "confirmado" && containsDate(window, e.date),
  );
  const receivedCents = receivedEntries.length > 0
    ? sumCents(receivedEntries.map((e) => e.amountCents))
    : ZERO_CENTS;

  // Vencido = emitido, não pago, com vencimento anterior a `asOf`.
  const overdueInvoices = issuedInvoices.filter(
    (inv) => !isPaidInvoice(inv.status) && inv.dueDate != null && inv.dueDate < asOf,
  );
  const overdueCents = overdueInvoices.length > 0
    ? sumCents(overdueInvoices.map((i) => i.grossCents))
    : ZERO_CENTS;

  if (invoicesOk && cashOk && receivedCents > invoicedCents) {
    issues.push(
      issue("RECEIVED_GT_INVOICED", {
        source: "cash_flow_entries",
        detail:
          `recebido (${receivedCents}) excede o faturado (${invoicedCents}) no período. `
          + "Pode ser legítimo (recebimento de faturas de períodos anteriores) — não é "
          + "corrigido automaticamente, só assinalado.",
      }),
    );
  }

  // ── Custos ────────────────────────────────────────────────────────────────
  //
  // Folha e despesa são somadas SEM dupla contagem: as saídas de caixa com
  // categoria `salario` são espelho da folha e ficam de fora do bloco de
  // despesas. Contá-las nas duas parcelas duplicaria o custo do mês inteiro.
  const payrollRows = payroll.filter((p) =>
    monthsCovered(window).some(
      (m) => m.start.slice(0, 7) === `${p.periodYear}-${String(p.periodMonth).padStart(2, "0")}`,
    ),
  );
  const payrollCents = payrollRows.length > 0
    ? sumCents(payrollRows.map((p) => p.netSalaryCents))
    : ZERO_CENTS;

  const expenseEntries = cashFlow.filter(
    (e) =>
      e.type === "saida"
      && e.status === "confirmado"
      && e.category !== "salario"
      && containsDate(window, e.date),
  );
  const expensesCents = expenseEntries.length > 0
    ? sumCents(expenseEntries.map((e) => e.amountCents))
    : ZERO_CENTS;

  const costCents = assertMoneyCents(payrollCents + expensesCents, "cost");

  // ── Montagem ──────────────────────────────────────────────────────────────
  const financialParts = {
    contracted: computeContracted(contracts, window, contractsOk),
  };
  issues.push(...financialParts.contracted.issues);

  const summary = buildSummary(
    {
      contracted: financialParts.contracted.value,
      scheduled: servicesCompleteness === "UNAVAILABLE"
        ? unavailable("service_scheduled", "serviços não carregados")
        : amount(scheduledVat.grossCents, "service_scheduled", servicesCompleteness),
      performed: servicesCompleteness === "UNAVAILABLE"
        ? unavailable("service_completed", "serviços não carregados")
        : amount(performedVat.grossCents, "service_completed", servicesCompleteness),
      invoiced: invoicesOk
        ? amount(invoicedCents, "invoice")
        : unavailable("invoice", "faturas não carregadas"),
      received: cashOk
        ? amount(receivedCents, "cash_flow")
        : unavailable("cash_flow", "caixa não carregada"),
      overdue: invoicesOk
        ? amount(overdueCents, "invoice")
        : unavailable("invoice", "faturas não carregadas"),
      cost: payrollOk || cashOk
        ? amount(
            costCents,
            "payroll",
            payrollOk && cashOk ? "COMPLETE" : "PARTIAL",
            payrollOk && cashOk ? undefined : "folha ou caixa em falta",
          )
        : unavailable("payroll", "folha e caixa não carregadas"),
    },
    marginBasis,
  );

  if (summary.outstanding.cents != null && summary.outstanding.cents < 0) {
    issues.push(
      issue("NEGATIVE_OUTSTANDING", {
        detail:
          `em aberto negativo (${summary.outstanding.cents} cêntimos): recebido excede o `
          + "faturado do período",
      }),
    );
  }

  const financial: ReportFinancials = {
    ...summary,
    expenses: cashOk
      ? amount(expensesCents, "cash_flow")
      : unavailable("cash_flow", "caixa não carregada"),
    payroll: payrollOk
      ? amount(payrollCents, "payroll")
      : unavailable("payroll", "folha não carregada"),
    vat: performedVat,
    vatRatePct,
    marginBasis,
  };

  return {
    financial,
    operations,
    metadata: {
      period: window,
      periodKey: periodKey(window),
      wholeMonth: isWholeMonth(window),
      asOf,
      generatedAt: input.generatedAt ?? null,
      freshestSourceAt: input.freshestSourceAt ?? null,
      completeness: computeCompleteness(outcomes),
      sources: outcomes,
      integrityIssues: sortIssues(issues),
    },
  };
}

// ─── Séries ─────────────────────────────────────────────────────────────────

/**
 * Série diária de um período, incluindo os dias vazios.
 *
 * Chama `buildReport` uma vez por dia, sobre os MESMOS dados carregados. É a
 * definição operacional da paridade: o dia e o mês não têm caminhos de código
 * diferentes, têm janelas diferentes.
 *
 * Os dias vazios entram na série com zeros — um dia sem serviços tem de
 * aparecer no gráfico, não desaparecer do eixo (a Faturação Diária actual
 * constrói o mapa só a partir dos dias com serviço).
 */
export function buildDailySeries(input: ReportInput): DailyReportPoint[] {
  return eachDay(input.window).map((date) => ({
    date,
    report: buildReport({ ...input, window: { start: date, end: date } }),
  }));
}

/**
 * Grandezas aditivas: somam-se os dias e tem de dar o mês.
 *
 * A lista é curta e explícita porque forçar a soma onde a semântica não cabe é
 * exactamente o que produz totais que ninguém consegue reconciliar. O que ficou
 * de fora, e porquê:
 *
 *   • `contracted` — a avença é um valor MENSAL. Cada janela diária do mês vê o
 *     mesmo contrato, por isso somar 31 dias daria 31 mensalidades.
 *   • `payroll` e `cost` — a folha é mensal pela mesma razão: `payroll_records`
 *     tem `period_year`/`period_month`, não uma data. Cada dia do mês "contém" o
 *     registo inteiro. `cost` é `payroll + expenses`, e herda a contaminação:
 *     só a parcela `expenses` (movimentos de caixa datados) é aditiva.
 *   • `overdue` — é um SALDO num instante (`asOf`), não um fluxo. Somar saldos
 *     diários não tem significado.
 *   • `outstanding` — derivado de dois saldos, herda o mesmo problema.
 *
 * Esta distinção não é teórica: foi um teste de paridade a apanhá-la. Somar a
 * série diária de `cost` de agosto dava 31 × a folha do mês.
 */
export const ADDITIVE_CONCEPTS = [
  "scheduled",
  "performed",
  "invoiced",
  "received",
  "expenses",
] as const;

/**
 * Grandezas que NÃO se somam entre dias, com a razão de cada uma. Existe para
 * que a UI possa recusar-se a somar em vez de o descobrir num total errado.
 */
export const NON_ADDITIVE_CONCEPTS = {
  contracted: "valor mensal do contrato — cada dia do mês vê o mesmo",
  payroll: "payroll_records é por período mensal, não por data",
  cost: "inclui a folha, que é mensal",
  overdue: "saldo num instante (asOf), não um fluxo",
  outstanding: "derivado de saldos",
} as const;

export type AdditiveConcept = (typeof ADDITIVE_CONCEPTS)[number];

export type NonAdditiveConcept = keyof typeof NON_ADDITIVE_CONCEPTS;

/**
 * Prova de paridade: para cada conceito aditivo, a soma dos dias tem de bater
 * exactamente com o valor do mês.
 *
 * Devolve as divergências. Lista vazia = paridade verificada.
 */
export function checkDailyMonthlyParity(
  monthly: ReportReadModel,
  daily: readonly DailyReportPoint[],
): { concept: AdditiveConcept; monthlyCents: number | null; dailySumCents: number }[] {
  const out: { concept: AdditiveConcept; monthlyCents: number | null; dailySumCents: number }[] = [];

  for (const concept of ADDITIVE_CONCEPTS) {
    const monthlyCents = monthly.financial[concept].cents;
    let dailySum = 0;
    for (const point of daily) {
      dailySum += point.report.financial[concept].cents ?? 0;
    }
    if (monthlyCents !== dailySum) {
      out.push({ concept, monthlyCents, dailySumCents: dailySum });
    }
  }

  return out;
}

/** Métricas operacionais somadas a partir da série diária. */
export function sumDailyOperations(daily: readonly DailyReportPoint[]): OperationalMetrics {
  return sumOperationalMetrics(daily.map((d) => d.report.operations));
}

/** Todos os problemas de integridade da série, sem repetições por código+sujeito. */
export function collectSeriesIssues(daily: readonly DailyReportPoint[]): IntegrityIssue[] {
  const seen = new Set<string>();
  const out: IntegrityIssue[] = [];
  for (const point of daily) {
    for (const i of point.report.metadata.integrityIssues) {
      const key = `${i.code}|${i.subject ?? ""}|${i.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i);
    }
  }
  return sortIssues(out);
}

/** `true` se a janela cobre por inteiro o mês de cada data indicada. */
export function windowCoversMonthsOf(
  window: CivilPeriod,
  dates: readonly CivilDate[],
): boolean {
  return dates.every((d) => coversWholeMonthOf(window, d));
}
