// ============================================================================
// T15 — Read model do dashboard financeiro
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Compõe DTOs a partir de relatórios da T14 já construídos. Não lê
// a base, não escreve, não conhece Supabase, **não lê o relógio**, e **não faz
// uma única conta de dinheiro** — toda a aritmética vive na T11.
//
// ----------------------------------------------------------------------------
//
// O que este ficheiro NÃO é.
//
// Não é um segundo read model. A T14 já responde a "quanto aconteceu neste
// período"; a T15 responde a "como é que isso se apresenta num dashboard":
// que cartões, que séries, contra que período se compara, o que se projecta.
//
// Se um valor não vem da T14, não vem de lado nenhum. Uma guarda estática
// impede que este módulo importe `money`, `vat` ou `monthly-allocation`
// directamente para fazer contas próprias.
//
// ----------------------------------------------------------------------------
//
// O defeito central que isto fecha: nomes.
//
// O KPI grande do dashboard chama-se **"Receita"**. O que soma é:
//
//     invoices.total  (COM IVA)  ·  status ≠ cancelado  (INCLUI rascunho)
//
// Ou seja: **faturado bruto, com imposto, com rascunhos**. Três diferenças face
// ao que a palavra "receita" sugere, nenhuma delas visível no ecrã.
//
// E a "Margem Bruta" é `esse número − folha de pagamento`:
//
//   • o IVA entra como se fosse receita da empresa — não é, é do Estado;
//   • as despesas de caixa (`cash_flow_entries`) **não entram nos custos** de
//     todo. Só a folha. A margem está inflacionada dos dois lados.
//
// No mesmo ecrã, os cartões "Hoje / Esta semana / Este mês" mostram outro
// número ainda — valor dos SERVIÇOS, com IVA, com a avença dividida por um
// denominador tirado da memória (o defeito §4.3 da T11). Nada explica ao
// utilizador porque é que "Este mês" e "Receita" discordam.
//
// A T15 não muda um único texto visível. Fixa os conceitos com o nome certo e
// **documenta a divergência**, para que a interface nova possa nascer correcta.

import { type CivilDate } from "../scheduling/civil-date";
import { type FinancialAmount, type MarginBasis } from "../billing/financial-model";
import { type CivilPeriod } from "../reports/period";
import {
  type DailyReportPoint,
  type ReportReadModel,
} from "../reports/report-read-model";
import { type OperationalMetrics } from "../reports/operational-metrics";
import {
  type PeriodComparison,
  type PercentDelta,
  compareAmounts,
  compareCounts,
  percentOf,
  unavailableComparison,
  type CountComparison,
} from "./comparison";
import { type FinancialDataHealth, buildDataHealth, mergeDataHealth } from "./data-health";
import { type DashboardPeriods, monthKeyOf } from "./period-selection";
import {
  type ProjectionMethod,
  type ProjectionResult,
  CURRENT_PROJECTION_METHOD,
  projectAnnual,
} from "./projection";
import {
  type ClientFinancialSummary,
  type ClientRankingBasis,
  topClientsBy,
} from "./client-summary";

// ─── KPI ────────────────────────────────────────────────────────────────────

/**
 * Estado de um KPI individual.
 *
 * Existe **por KPI** e não só globalmente: se a caixa falhou, `received` fica
 * `UNAVAILABLE` mas `invoiced` continua fiável, e a interface deve poder
 * mostrar um e esconder o outro em vez de degradar a página inteira.
 */
export type KpiAvailability = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";

/**
 * Um cartão do dashboard, já decidido.
 *
 * `label` é o **nome canónico** do conceito (Faturado, Recebido, Realizado…),
 * não o texto actual do ecrã. `legacyLabel` guarda o texto que o dashboard usa
 * hoje quando é diferente — é o registo da divergência, para que a UI nova não
 * a herde sem dar por isso.
 */
export interface DashboardKpi {
  key: DashboardKpiKey;
  label: string;
  legacyLabel: string | null;
  amount: FinancialAmount;
  availability: KpiAvailability;
  comparison: PeriodComparison;
  /** Nota técnica quando o valor não é o que o nome antigo sugeria. */
  divergenceNote?: string;
}

export type DashboardKpiKey =
  | "contracted"
  | "scheduled"
  | "performed"
  | "invoiced"
  | "received"
  | "outstanding"
  | "overdue"
  | "expenses"
  | "payroll"
  | "cost"
  | "margin";

const KPI_LABELS: Record<DashboardKpiKey, string> = {
  contracted: "Contratado",
  scheduled: "Agendado",
  performed: "Realizado",
  invoiced: "Faturado",
  received: "Recebido",
  outstanding: "Em aberto",
  overdue: "Vencido",
  expenses: "Despesas",
  payroll: "Folha",
  cost: "Custos",
  margin: "Margem",
};

/**
 * O que o dashboard actual chama a cada conceito, quando difere do nome
 * canónico — e porquê isso é um problema.
 *
 * Registo documental. **Nenhum destes textos é alterado por esta task.**
 */
export const LEGACY_KPI_NAMING: Partial<Record<DashboardKpiKey, {
  legacyLabel: string;
  note: string;
}>> = {
  invoiced: {
    legacyLabel: "Receita",
    note:
      "o cartão soma invoices.total (COM IVA) e inclui rascunhos "
      + "(o filtro é apenas status ≠ cancelado). Não é receita: é faturado bruto.",
  },
  cost: {
    legacyLabel: "Custos (Salários)",
    note:
      "só conta payroll_records. As despesas de cash_flow_entries não entram, "
      + "o que subestima os custos e inflaciona a margem.",
  },
  margin: {
    legacyLabel: "Margem Bruta",
    note:
      "faturado COM IVA menos apenas a folha. O imposto entra como se fosse "
      + "receita da empresa, e as despesas ficam de fora.",
  },
  overdue: {
    legacyLabel: "Pendente a Receber",
    note:
      "soma faturas com status pendente|vencido em TODA a janela de 12 meses, "
      + "não no mês do cartão, e usa o texto do status em vez de due_date.",
  },
};

function availabilityOf(amount: FinancialAmount): KpiAvailability {
  switch (amount.completeness) {
    case "COMPLETE": return "AVAILABLE";
    case "PARTIAL": return "PARTIAL";
    case "UNAVAILABLE": return "UNAVAILABLE";
  }
}

/**
 * Conceitos cuja comparação entre períodos é entre **saldos**, não fluxos.
 * A UI deve dizê-lo — ver `PeriodComparison.snapshot`.
 */
const SNAPSHOT_KPIS: ReadonlySet<DashboardKpiKey> = new Set([
  "contracted", "outstanding", "overdue", "payroll", "cost",
]);

function amountOf(report: ReportReadModel, key: DashboardKpiKey): FinancialAmount {
  return report.financial[key];
}

function buildKpi(
  key: DashboardKpiKey,
  current: ReportReadModel,
  previous: ReportReadModel | null,
): DashboardKpi {
  const amount = amountOf(current, key);
  const legacy = LEGACY_KPI_NAMING[key];
  return {
    key,
    label: KPI_LABELS[key],
    legacyLabel: legacy?.legacyLabel ?? null,
    amount,
    availability: availabilityOf(amount),
    comparison: previous
      ? compareAmounts(amount, amountOf(previous, key), { snapshot: SNAPSHOT_KPIS.has(key) })
      : unavailableComparison(SNAPSHOT_KPIS.has(key)),
    divergenceNote: legacy?.note,
  };
}

// ─── Séries ─────────────────────────────────────────────────────────────────

/** Um ponto da série diária. Todos os dias do período, vazios incluídos. */
export interface DashboardDailyPoint {
  date: CivilDate;
  performed: FinancialAmount;
  invoiced: FinancialAmount;
  received: FinancialAmount;
  expenses: FinancialAmount;
  /**
   * `null` quando a margem diária não é semanticamente válida — o que é o caso
   * sempre que a base inclui custos, porque a folha é mensal (ver
   * `NON_ADDITIVE_CONCEPTS` na T14). Não se inventa uma margem por dia.
   */
  margin: FinancialAmount | null;
  services: number;
  completed: number;
  cancelled: number;
}

/** Um ponto da série mensal. */
export interface DashboardMonthlyPoint {
  monthKey: string;
  period: CivilPeriod;
  performed: FinancialAmount;
  invoiced: FinancialAmount;
  received: FinancialAmount;
  cost: FinancialAmount;
  margin: FinancialAmount;
  /** `margin / base da margem`, com a política de denominador zero explícita. */
  marginPercent: PercentDelta;
  services: number;
  completed: number;
}

// ─── A vista completa ───────────────────────────────────────────────────────

export interface DashboardOperational {
  scheduledServices: number;
  completedServices: number;
  cancelledServices: number;
  absences: number;
  comparison: {
    scheduledServices: CountComparison;
    completedServices: CountComparison;
    cancelledServices: CountComparison;
    absences: CountComparison;
  };
}

export interface DashboardFinancialView {
  period: CivilPeriod;
  periodKey: string;
  /** Período com que se compara. `null` se não foi carregado. */
  comparisonPeriod: CivilPeriod | null;
  health: FinancialDataHealth;
  kpis: Record<DashboardKpiKey, DashboardKpi>;
  operational: DashboardOperational;
  marginBasis: MarginBasis;
  series: {
    daily: DashboardDailyPoint[];
    monthly: DashboardMonthlyPoint[];
  };
  projection: ProjectionResult | null;
  topClients: ClientFinancialSummary[];
  topClientsBasis: ClientRankingBasis;
}

export interface DashboardInput {
  periods: DashboardPeriods;
  /** Relatório T14 do período principal (normalmente o mês corrente). */
  current: ReportReadModel;
  /** Relatório T14 do período anterior. `null` se não foi carregado. */
  previous?: ReportReadModel | null;
  /** Série diária do período principal, da T14. */
  daily?: readonly DailyReportPoint[];
  /** Relatórios mensais dos últimos 12 meses, por ordem cronológica. */
  monthly?: readonly ReportReadModel[];
  /** Resumos por cliente, já agregados. */
  clients?: readonly ClientFinancialSummary[];
  topClientsBasis?: ClientRankingBasis;
  projectionMethod?: ProjectionMethod;
  /** Dias do ano decorridos/totais, para a projecção por dia civil. */
  elapsedDaysInYear?: number;
  totalDaysInYear?: number;
  generatedAt?: string | null;
  freshestSourceAt?: string | null;
}

const ALL_KPI_KEYS: readonly DashboardKpiKey[] = [
  "contracted", "scheduled", "performed", "invoiced", "received",
  "outstanding", "overdue", "expenses", "payroll", "cost", "margin",
];

function healthOf(report: ReportReadModel, input: DashboardInput): FinancialDataHealth {
  return buildDataHealth({
    completeness: report.metadata.completeness,
    sources: report.metadata.sources,
    issues: report.metadata.integrityIssues,
    generatedAt: input.generatedAt ?? report.metadata.generatedAt,
    freshestSourceAt: input.freshestSourceAt ?? report.metadata.freshestSourceAt,
  });
}

function operationalOf(
  current: OperationalMetrics,
  previous: OperationalMetrics | null,
): DashboardOperational {
  const prev = previous ?? {
    scheduled: 0, completed: 0, cancelled: 0, absences: 0,
  } as OperationalMetrics;
  return {
    scheduledServices: current.scheduled,
    completedServices: current.completed,
    cancelledServices: current.cancelled,
    absences: current.absences,
    comparison: {
      scheduledServices: compareCounts(current.scheduled, prev.scheduled),
      completedServices: compareCounts(current.completed, prev.completed),
      cancelledServices: compareCounts(current.cancelled, prev.cancelled),
      absences: compareCounts(current.absences, prev.absences),
    },
  };
}

/**
 * Constrói a vista do dashboard.
 *
 * Composição pura: escolhe, rotula, compara e ordena. **Não soma dinheiro** —
 * cada `FinancialAmount` sai tal como a T14 o construiu.
 */
export function buildDashboardView(input: DashboardInput): DashboardFinancialView {
  const { current } = input;
  const previous = input.previous ?? null;

  const kpis = Object.fromEntries(
    ALL_KPI_KEYS.map((key) => [key, buildKpi(key, current, previous)]),
  ) as Record<DashboardKpiKey, DashboardKpi>;

  const daily: DashboardDailyPoint[] = (input.daily ?? []).map((point) => {
    const f = point.report.financial;
    const o = point.report.operations;
    return {
      date: point.date,
      performed: f.performed,
      invoiced: f.invoiced,
      received: f.received,
      expenses: f.expenses,
      // A margem diária ficaria contaminada pela folha, que é mensal.
      margin: null,
      services: o.counts.total,
      completed: o.completed,
      cancelled: o.cancelled,
    };
  });

  const monthly: DashboardMonthlyPoint[] = (input.monthly ?? []).map((report) => {
    const f = report.financial;
    const basisAmount = f[report.financial.marginBasis];
    return {
      monthKey: monthKeyOf(report.metadata.period),
      period: report.metadata.period,
      performed: f.performed,
      invoiced: f.invoiced,
      received: f.received,
      cost: f.cost,
      margin: f.margin,
      marginPercent: percentOf(f.margin.cents, basisAmount.cents),
      services: report.operations.counts.total,
      completed: report.operations.completed,
    };
  });

  const projection: ProjectionResult | null = input.monthly && input.monthly.length > 0
    ? projectAnnual({
        monthlyCents: monthlyCentsOfCurrentYear(input),
        currentMonth: currentMonthOf(input.periods),
        elapsedDaysInYear: input.elapsedDaysInYear ?? 0,
        totalDaysInYear: input.totalDaysInYear ?? 0,
        method: input.projectionMethod ?? CURRENT_PROJECTION_METHOD,
      })
    : null;

  const topClientsBasis: ClientRankingBasis = input.topClientsBasis ?? "invoiced";

  const healthParts = [healthOf(current, input)];
  for (const m of input.monthly ?? []) healthParts.push(healthOf(m, input));

  return {
    period: current.metadata.period,
    periodKey: current.metadata.periodKey,
    comparisonPeriod: previous?.metadata.period ?? null,
    health: mergeDataHealth(healthParts),
    kpis,
    operational: operationalOf(current.operations, previous?.operations ?? null),
    marginBasis: current.financial.marginBasis,
    series: { daily, monthly },
    projection,
    topClients: topClientsBy(input.clients ?? [], topClientsBasis),
    topClientsBasis,
  };
}

/** Mês corrente (1–12), lido dos períodos já construídos. Não usa relógio. */
function currentMonthOf(periods: DashboardPeriods): number {
  return Number(periods.month.start.slice(5, 7));
}

/**
 * Valores mensais do ANO CORRENTE, do mês 1 ao corrente.
 *
 * Filtra a janela de 12 meses (que atravessa o ano anterior) para o ano do
 * período principal — projectar "o ano" com meses do ano passado seria somar
 * coisas de anos diferentes, que é o tipo de erro que a T11 fechou no dinheiro.
 */
function monthlyCentsOfCurrentYear(input: DashboardInput): (import("../billing/money").MoneyCents | null)[] {
  const year = input.periods.month.start.slice(0, 4);
  const currentMonth = currentMonthOf(input.periods);
  const byMonth = new Map<number, ReportReadModel>();

  for (const report of input.monthly ?? []) {
    const key = monthKeyOf(report.metadata.period);
    if (key.slice(0, 4) !== year) continue;
    byMonth.set(Number(key.slice(5, 7)), report);
  }

  const out: (import("../billing/money").MoneyCents | null)[] = [];
  for (let month = 1; month <= currentMonth; month++) {
    const report = byMonth.get(month);
    if (!report) { out.push(null); continue; }
    const basis = report.financial[report.financial.marginBasis];
    out.push(basis.completeness === "UNAVAILABLE" ? null : basis.cents);
  }
  return out;
}

// ─── Selectores ─────────────────────────────────────────────────────────────

/** KPIs em que se pode confiar para decidir. */
export function trustworthyKpis(view: DashboardFinancialView): DashboardKpi[] {
  return ALL_KPI_KEYS
    .map((k) => view.kpis[k])
    .filter((kpi) => kpi.availability === "AVAILABLE");
}

/** KPIs cuja fonte falhou — a UI deve escondê-los ou marcá-los, nunca pôr 0. */
export function unavailableKpis(view: DashboardFinancialView): DashboardKpi[] {
  return ALL_KPI_KEYS
    .map((k) => view.kpis[k])
    .filter((kpi) => kpi.availability === "UNAVAILABLE");
}

/** KPIs cujo nome actual no ecrã não corresponde ao conceito que mostram. */
export function misnamedKpis(view: DashboardFinancialView): DashboardKpi[] {
  return ALL_KPI_KEYS
    .map((k) => view.kpis[k])
    .filter((kpi) => kpi.legacyLabel != null && kpi.legacyLabel !== kpi.label);
}

/**
 * Contratado × realizado.
 *
 * Devolve o delta e **nada mais**. A diferença não é "perda": pode ser trabalho
 * ainda por fazer no mês, cancelamentos, faltas, um contrato que começou a meio
 * (com `PRORATED` ainda em standby na T11) ou uma avença sem ocorrências. Tirar
 * conclusões daqui é do domínio de quem lê, não deste módulo.
 */
export function contractedVsPerformed(view: DashboardFinancialView): {
  contracted: FinancialAmount;
  performed: FinancialAmount;
  deltaCents: number | null;
  comparable: boolean;
} {
  const contracted = view.kpis.contracted.amount;
  const performed = view.kpis.performed.amount;
  const comparable =
    contracted.completeness !== "UNAVAILABLE" && performed.completeness !== "UNAVAILABLE";
  return {
    contracted,
    performed,
    deltaCents: comparable ? (performed.cents ?? 0) - (contracted.cents ?? 0) : null,
    comparable,
  };
}

/**
 * Faturado × recebido.
 *
 * `outstanding` vem da T11 já derivado, e **pode ser negativo** — nunca se faz
 * clamp a zero. Recebido acima de faturado é informação (recebimento de faturas
 * de períodos anteriores, ou um erro real), e a T14 já o assinala com
 * `RECEIVED_GT_INVOICED`.
 */
export function invoicedVsReceived(view: DashboardFinancialView): {
  invoiced: FinancialAmount;
  received: FinancialAmount;
  outstanding: FinancialAmount;
  receivedExceedsInvoiced: boolean;
} {
  const invoiced = view.kpis.invoiced.amount;
  const received = view.kpis.received.amount;
  const outstanding = view.kpis.outstanding.amount;
  return {
    invoiced,
    received,
    outstanding,
    receivedExceedsInvoiced: outstanding.cents != null && outstanding.cents < 0,
  };
}
