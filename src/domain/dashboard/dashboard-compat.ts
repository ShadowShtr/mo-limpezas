// ============================================================================
// T15 — Comparador: dashboard antigo × read model canónico
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Compara duas implementações sobre FIXTURES SINTÉTICAS. Não lê a
// base, não escreve, não liga ao Supabase.
//
// ----------------------------------------------------------------------------
//
// MEDE: que classes de divergência existem entre o que o dashboard mostra hoje
// e o que o modelo canónico calcula, para os mesmos dados.
//
// NÃO MEDE: impacto real. As fixtures são inventadas. Transformar estes números
// numa estimativa em euros de produção seria a falácia que a T11 (§4.9) e a T14
// (§8) já assinalaram.

import { type MoneyCents, eurosToCents } from "../billing/money";
import { extractVatFromGross } from "../billing/vat";
import { sourceOk } from "../reports/integrity";
import { monthPeriod } from "../reports/period";
import {
  type MonthlyOccurrenceSet,
  type ReportInput,
  type ReportReadModel,
  buildReport,
} from "../reports/report-read-model";
import type {
  CashFlowInput,
  ContractInput,
  InvoiceInput,
  PayrollInput,
  ServiceInput,
} from "../reports/report-sources";
import {
  type LegacyInvoiceRow,
  type LegacyPayrollRow,
  legacyClientRevenue,
  legacyMarginPct,
  legacyMonthlyAggregation,
  legacyPendingRevenue,
  legacyProjectedAnnual,
} from "./legacy-dashboard";
import { percentOf } from "./comparison";
import { projectAnnual } from "./projection";
import { buildClientSummaries, topClientsBy } from "./client-summary";

// ─── Casos ──────────────────────────────────────────────────────────────────

export interface DashboardCase {
  label: string;
  year: number;
  month: number;
  vatRatePct: number;
  /** Faturas do mês: `[total com IVA, estado, clienteId]`. */
  invoices: readonly (readonly [number, string, string])[];
  /** Folha do mês, em euros. */
  payrollEuros: number;
  /** Despesas de caixa do mês (categoria ≠ salario), em euros. */
  expensesEuros: number;
  /** Entradas confirmadas em caixa no mês, em euros. */
  receivedEuros: number;
  /** Serviços avulsos concluídos: `[estado, valor em euros, clienteId]`. */
  services: readonly (readonly [string, number, string])[];
  /** Receita mensal dos meses anteriores do ano, para a projecção. */
  priorMonthsRevenueEuros: readonly number[];
}

export type DashboardDivergenceReason =
  /** O KPI "Receita" inclui IVA. */
  | "REVENUE_INCLUDES_VAT"
  /** O KPI "Receita" inclui faturas em rascunho. */
  | "REVENUE_INCLUDES_DRAFTS"
  /** Os custos ignoram as despesas de caixa. */
  | "COSTS_IGNORE_EXPENSES"
  /** A margem sai inflacionada (receita bruta menos só a folha). */
  | "MARGIN_INFLATED"
  /** A percentagem de margem devolve 0% em vez de "incomparável". */
  | "MARGIN_PCT_ZERO_MASK"
  /** A margem negativa é achatada no gráfico. */
  | "NEGATIVE_MARGIN_CLAMPED"
  /** A projecção usa numerador e denominador de conjuntos diferentes. */
  | "PROJECTION_MISMATCHED_BASIS"
  /** Um cliente com trabalho feito e sem fatura não aparece no gráfico. */
  | "CLIENT_WITHOUT_INVOICE_HIDDEN"
  /** "Pendente a receber" não é do período do cartão. */
  | "PENDING_NOT_PERIOD_SCOPED";

export interface DashboardCaseComparison {
  label: string;
  /** KPI "Receita" antigo (cêntimos) × faturado canónico. */
  legacyRevenueCents: number;
  canonicalInvoicedCents: number | null;
  revenueDriftCents: number;
  /** Custos antigos (só folha) × custos canónicos (folha + despesas). */
  legacyCostCents: number;
  canonicalCostCents: number | null;
  costDriftCents: number;
  /** Margem antiga × canónica. */
  legacyMarginCents: number;
  canonicalMarginCents: number | null;
  marginDriftCents: number;
  /** Percentagem de margem: antiga (número) × canónica (tipada). */
  legacyMarginPct: number;
  canonicalMarginPctKind: string;
  /** Projecção antiga × variante canónica por meses completos. */
  legacyProjectionCents: number;
  canonicalProjectionCents: number | null;
  projectionDriftCents: number;
  /** Clientes visíveis em cada gráfico. */
  legacyClientCount: number;
  canonicalClientCount: number;
  hiddenClients: number;
  reasons: DashboardDivergenceReason[];
  diverges: boolean;
}

export interface DashboardCompatSummary {
  totalCases: number;
  unchanged: number;
  changed: number;
  totalRevenueDriftCents: number;
  totalCostDriftCents: number;
  totalMarginDriftCents: number;
  totalProjectionDriftCents: number;
  totalHiddenClients: number;
  byReason: Record<DashboardDivergenceReason, number>;
  worstMarginDriftLabel: string | null;
  worstMarginDriftCents: number;
}

export interface DashboardCompatReport {
  summary: DashboardCompatSummary;
  cases: DashboardCaseComparison[];
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function cents(euros: number): MoneyCents {
  const c = eurosToCents(euros);
  if (c == null) throw new RangeError(`valor inválido: ${euros}`);
  return c;
}

function buildCanonical(c: DashboardCase): ReportReadModel {
  const window = monthPeriod(c.year, c.month);
  if (!window) throw new RangeError(`mês inválido: ${c.year}-${c.month}`);
  const monthKey = window.start.slice(0, 7);

  const invoices: InvoiceInput[] = c.invoices.map(([total, status], i) => {
    // A fixture declara o total COM IVA, como a coluna `invoices.total`.
    // `extractVatFromGross` é o caminho inverso canónico da T11: mantém a
    // invariante net + vat = gross fechada, sem esta fixture inventar a sua
    // própria conta de imposto (que foi precisamente o defeito da T11).
    const parts = extractVatFromGross(cents(total), {
      applyVat: true,
      ratePct: c.vatRatePct,
    });
    return {
      id: `inv-${i}`,
      periodStart: `${monthKey}-01`,
      dueDate: `${monthKey}-28`,
      netCents: parts.netCents,
      vatCents: parts.vatCents,
      grossCents: parts.grossCents,
      vatRatePct: c.vatRatePct,
      status,
      itemCount: 1,
    };
  });

  const services: ServiceInput[] = c.services.map(([status, euros], i) => ({
    id: `svc-${i}`,
    occurrenceDate: `${monthKey}-${String(Math.min(28, i + 1)).padStart(2, "0")}`,
    status,
    contractId: null,
    valueCents: cents(euros),
    applyVat: false,
    workedMinutes: null,
    scheduledMinutes: 60,
  }));

  const cashFlow: CashFlowInput[] = [];
  if (c.receivedEuros !== 0) {
    cashFlow.push({
      id: "cf-in", date: `${monthKey}-15`, type: "entrada",
      amountCents: cents(c.receivedEuros), category: "faturacao", status: "confirmado",
    });
  }
  if (c.expensesEuros !== 0) {
    cashFlow.push({
      id: "cf-out", date: `${monthKey}-16`, type: "saida",
      amountCents: cents(c.expensesEuros), category: "despesa", status: "confirmado",
    });
  }

  const payroll: PayrollInput[] = c.payrollEuros === 0 ? [] : [{
    id: "pay-1", periodYear: c.year, periodMonth: c.month,
    netSalaryCents: cents(c.payrollEuros), status: "pago",
  }];

  const input: ReportInput = {
    window,
    asOf: window.end,
    marginBasis: "invoiced",
    sources: {
      services: sourceOk(services),
      contracts: sourceOk<ContractInput>([]),
      invoices: sourceOk(invoices),
      cashFlow: sourceOk(cashFlow),
      payroll: sourceOk(payroll),
      timesheets: sourceOk([]),
      absences: sourceOk([]),
      vat: sourceOk([{ ratePct: c.vatRatePct }]),
    },
    monthlyOccurrences: [] as MonthlyOccurrenceSet[],
  };

  return buildReport(input);
}

// ─── Comparação ─────────────────────────────────────────────────────────────

export function compareDashboardCase(c: DashboardCase): DashboardCaseComparison {
  const canonical = buildCanonical(c);
  const monthKey = `${c.year}-${String(c.month).padStart(2, "0")}`;

  const legacyInvoices: LegacyInvoiceRow[] = c.invoices.map(([total, status, clientId]) => ({
    total, status, periodStart: `${monthKey}-01`, clientId,
  }));
  const legacyPayroll: LegacyPayrollRow[] = c.payrollEuros === 0 ? [] : [{
    periodYear: c.year, periodMonth: c.month, netSalary: c.payrollEuros,
  }];

  // ── Meses anteriores, para a projecção ──
  const priorMonths = c.priorMonthsRevenueEuros.map((revenue, i) => ({
    year: c.year, month: i + 1, revenue, costs: 0, margin: revenue,
  }));
  const legacyMonthlyRows = [
    ...priorMonths,
    ...legacyMonthlyAggregation(legacyInvoices, legacyPayroll, [{ year: c.year, month: c.month }]),
  ];
  const currentRow = legacyMonthlyRows[legacyMonthlyRows.length - 1];

  const legacyRevenueCents = Math.round(currentRow.revenue * 100);
  const legacyCostCents = Math.round(currentRow.costs * 100);
  const legacyMarginCents = Math.round(currentRow.margin * 100);

  const canonicalInvoicedCents = canonical.financial.invoiced.cents;
  const canonicalCostCents = canonical.financial.cost.cents;
  const canonicalMarginCents = canonical.financial.margin.cents;

  // ── Percentagem de margem ──
  const legacyPct = legacyMarginPct(currentRow.margin, currentRow.revenue);
  const canonicalPct = percentOf(canonicalMarginCents, canonicalInvoicedCents);

  // ── Projecção ──
  const legacyProjectionCents = Math.round(
    legacyProjectedAnnual(legacyMonthlyRows, c.year, c.month) * 100,
  );
  const canonicalProjection = projectAnnual({
    monthlyCents: legacyMonthlyRows.map((m) => Math.round(m.revenue * 100) as MoneyCents),
    currentMonth: c.month,
    elapsedDaysInYear: 0,
    totalDaysInYear: 0,
    method: "LINEAR_BY_COMPLETED_MONTHS",
  });

  // ── Clientes ──
  const legacyClients = legacyClientRevenue(legacyInvoices, c.year);
  const canonicalClients = topClientsBy(
    buildClientSummaries([
      ...c.invoices
        .filter(([, status]) => status !== "cancelado" && status !== "rascunho")
        .map(([total, , clientId]) => ({ clientId, invoicedCents: cents(total) })),
      ...c.services
        .filter(([status]) => status === "concluido")
        .map(([, euros, clientId]) => ({
          clientId, performedCents: cents(euros), completedServices: 1,
        })),
    ]),
    "invoiced",
  );

  // ── Razões ──
  const reasons: DashboardDivergenceReason[] = [];
  if (c.invoices.length > 0 && c.vatRatePct > 0) reasons.push("REVENUE_INCLUDES_VAT");
  if (c.invoices.some(([, s]) => s === "rascunho")) reasons.push("REVENUE_INCLUDES_DRAFTS");
  if (c.expensesEuros > 0) {
    reasons.push("COSTS_IGNORE_EXPENSES");
    reasons.push("MARGIN_INFLATED");
  }
  if (currentRow.revenue === 0 && currentRow.margin !== 0) reasons.push("MARGIN_PCT_ZERO_MASK");
  if (currentRow.margin < 0) reasons.push("NEGATIVE_MARGIN_CLAMPED");
  if (legacyProjectionCents !== (canonicalProjection.projectedCents ?? legacyProjectionCents)) {
    reasons.push("PROJECTION_MISMATCHED_BASIS");
  }
  const hiddenClients = Math.max(0, canonicalClients.length - legacyClients.length);
  if (hiddenClients > 0) reasons.push("CLIENT_WITHOUT_INVOICE_HIDDEN");
  if (legacyPendingRevenue(legacyInvoices) > 0) reasons.push("PENDING_NOT_PERIOD_SCOPED");

  const revenueDriftCents = (canonicalInvoicedCents ?? 0) - legacyRevenueCents;
  const costDriftCents = (canonicalCostCents ?? 0) - legacyCostCents;
  const marginDriftCents = (canonicalMarginCents ?? 0) - legacyMarginCents;
  const projectionDriftCents =
    (canonicalProjection.projectedCents ?? legacyProjectionCents) - legacyProjectionCents;

  return {
    label: c.label,
    legacyRevenueCents,
    canonicalInvoicedCents,
    revenueDriftCents,
    legacyCostCents,
    canonicalCostCents,
    costDriftCents,
    legacyMarginCents,
    canonicalMarginCents,
    marginDriftCents,
    legacyMarginPct: legacyPct,
    canonicalMarginPctKind: canonicalPct.kind,
    legacyProjectionCents,
    canonicalProjectionCents: canonicalProjection.projectedCents,
    projectionDriftCents,
    legacyClientCount: legacyClients.length,
    canonicalClientCount: canonicalClients.length,
    hiddenClients,
    reasons,
    diverges:
      reasons.length > 0
      || revenueDriftCents !== 0
      || costDriftCents !== 0
      || marginDriftCents !== 0,
  };
}

export function compareDashboardCases(
  cases: readonly DashboardCase[],
): DashboardCompatReport {
  const results = cases.map(compareDashboardCase);

  const byReason: Record<DashboardDivergenceReason, number> = {
    REVENUE_INCLUDES_VAT: 0,
    REVENUE_INCLUDES_DRAFTS: 0,
    COSTS_IGNORE_EXPENSES: 0,
    MARGIN_INFLATED: 0,
    MARGIN_PCT_ZERO_MASK: 0,
    NEGATIVE_MARGIN_CLAMPED: 0,
    PROJECTION_MISMATCHED_BASIS: 0,
    CLIENT_WITHOUT_INVOICE_HIDDEN: 0,
    PENDING_NOT_PERIOD_SCOPED: 0,
  };

  let totalRevenueDriftCents = 0;
  let totalCostDriftCents = 0;
  let totalMarginDriftCents = 0;
  let totalProjectionDriftCents = 0;
  let totalHiddenClients = 0;
  let worstMarginDriftLabel: string | null = null;
  let worstMarginDriftCents = 0;

  for (const r of results) {
    for (const reason of r.reasons) byReason[reason] += 1;
    totalRevenueDriftCents += r.revenueDriftCents;
    totalCostDriftCents += r.costDriftCents;
    totalMarginDriftCents += r.marginDriftCents;
    totalProjectionDriftCents += r.projectionDriftCents;
    totalHiddenClients += r.hiddenClients;
    if (Math.abs(r.marginDriftCents) > Math.abs(worstMarginDriftCents)) {
      worstMarginDriftCents = r.marginDriftCents;
      worstMarginDriftLabel = r.label;
    }
  }

  const changed = results.filter((r) => r.diverges).length;

  return {
    summary: {
      totalCases: results.length,
      unchanged: results.length - changed,
      changed,
      totalRevenueDriftCents,
      totalCostDriftCents,
      totalMarginDriftCents,
      totalProjectionDriftCents,
      totalHiddenClients,
      byReason,
      worstMarginDriftLabel,
      worstMarginDriftCents,
    },
    cases: results,
  };
}

// ─── Matriz determinística ──────────────────────────────────────────────────

export function defaultDashboardMatrix(vatRatePct = 23): DashboardCase[] {
  const base = { year: 2026, month: 3, vatRatePct };
  const empty = {
    invoices: [] as readonly (readonly [number, string, string])[],
    payrollEuros: 0,
    expensesEuros: 0,
    receivedEuros: 0,
    services: [] as readonly (readonly [string, number, string])[],
    priorMonthsRevenueEuros: [] as readonly number[],
  };

  return [
    { ...base, ...empty, label: "mês vazio" },

    {
      ...base, ...empty, label: "fatura emitida com IVA",
      invoices: [[1230, "pendente", "c1"]],
    },

    {
      ...base, ...empty, label: "rascunho conta como receita",
      invoices: [[1230, "pendente", "c1"], [5000, "rascunho", "c2"]],
    },

    {
      ...base, ...empty, label: "despesas ignoradas nos custos",
      invoices: [[1230, "pendente", "c1"]],
      payrollEuros: 500,
      expensesEuros: 300,
    },

    {
      ...base, ...empty, label: "margem negativa",
      invoices: [[100, "pendente", "c1"]],
      payrollEuros: 3000,
    },

    {
      ...base, ...empty, label: "margem negativa sem receita",
      payrollEuros: 3000,
    },

    {
      ...base, ...empty, label: "faturado sem recebido",
      invoices: [[1230, "pendente", "c1"]],
    },

    {
      ...base, ...empty, label: "recebido acima do faturado",
      invoices: [[100, "pago", "c1"]],
      receivedEuros: 500,
    },

    {
      ...base, ...empty, label: "cliente com serviço e sem fatura",
      invoices: [[1230, "pendente", "c1"]],
      services: [["concluido", 200, "c2"]],
    },

    {
      ...base, ...empty, label: "serviço cancelado e falta",
      invoices: [[1230, "pendente", "c1"]],
      services: [["cancelado", 200, "c1"], ["falta", 150, "c1"]],
    },

    {
      ...base, ...empty, label: "projecção com mês a zero antes do corrente",
      invoices: [[200, "pendente", "c1"]],
      priorMonthsRevenueEuros: [0, 1000],
    },

    {
      ...base, ...empty, label: "projecção com dois meses iguais",
      invoices: [[200, "pendente", "c1"]],
      priorMonthsRevenueEuros: [1000, 1000],
    },

    {
      ...base, month: 1, ...empty, label: "janeiro — nenhum mês completo",
      invoices: [[500, "pendente", "c1"]],
    },

    {
      ...base, month: 12, ...empty, label: "dezembro — ano quase fechado",
      invoices: [[500, "pendente", "c1"]],
      priorMonthsRevenueEuros: Array.from({ length: 11 }, () => 1000),
    },

    {
      ...base, ...empty, label: "só folha, sem faturação",
      payrollEuros: 2500,
      priorMonthsRevenueEuros: [1000, 1000],
    },
  ];
}
