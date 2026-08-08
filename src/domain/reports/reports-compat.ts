// ============================================================================
// T14 — Comparador: relatórios antigos × read model canónico
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Compara duas implementações sobre FIXTURES SINTÉTICAS. Não lê a
// base, não escreve, não liga ao Supabase.
//
// ----------------------------------------------------------------------------
//
// O que este comparador mede — e o que não mede.
//
// MEDE: para o mesmo conjunto de dados sintéticos, quanto difere cada conceito
// entre o que os relatórios calculam hoje e o que o modelo canónico calcula.
//
// NÃO MEDE: impacto real. As fixtures são inventadas. Transformar estes números
// numa estimativa de euros em produção seria a mesma falácia que a T11 já
// assinalou (§4.9). O impacto real exige ler produção, o que esta task não faz
// e não está autorizada a fazer.
//
// O valor do comparador é qualitativo: mostra QUE classes de divergência
// existem e em que condições aparecem.

import { type MoneyCents, eurosToCents } from "../billing/money";
import { type CivilPeriod, monthPeriod, periodDays } from "./period";
import {
  type AbsenceInput,
  type ContractInput,
  type ServiceInput,
} from "./report-sources";
import {
  type MonthlyOccurrenceSet,
  type ReportReadModel,
  buildReport,
} from "./report-read-model";
import { summariseAbsences, totalAbsenceDays } from "./absence-metrics";
import { countServices } from "./operational-metrics";
import {
  legacyCountServices,
  legacyDailyTotals,
  legacyRevenueFromServices,
  legacyTotalAbsenceDays,
} from "./legacy-reports";
import { sourceOk } from "./integrity";

// ─── Casos ──────────────────────────────────────────────────────────────────

/**
 * Um cenário sintético. Descreve um mês, um contrato e um punhado de serviços,
 * sem nenhum identificador real.
 */
export interface ReportCase {
  label: string;
  year: number;
  month: number;
  vatRatePct: number;
  /** Avença mensal em euros. `null` = não há contrato de avença no caso. */
  monthlyPriceEuros: number | null;
  applyVat: boolean;
  /** Ocorrências da avença: estado de cada uma, por ordem cronológica. */
  avencaStatuses: readonly string[];
  /** Serviços avulsos: `[estado, valor em euros]`. */
  adhoc: readonly (readonly [string, number])[];
  /** Ausências: `[início, fim]` em datas civis. */
  absences: readonly (readonly [string, string])[];
}

export type DivergenceReason =
  /** Cêntimos perdidos na divisão da avença. */
  | "CENTS_LOST_IN_SPLIT"
  /** A avença não aparece de todo na receita antiga. */
  | "MONTHLY_INVISIBLE_IN_REVENUE"
  /** Absentismo contado para além do período. */
  | "ABSENCE_OVERCOUNTED"
  /** Estados agrupados no balde "agendado". */
  | "STATUS_BUCKETED"
  /** Dias sem serviço ausentes da série. */
  | "EMPTY_DAYS_MISSING"
  /** IVA aplicado sobre a soma em vez de linha a linha. */
  | "VAT_ON_AGGREGATE";

export interface CaseComparison {
  label: string;
  window: CivilPeriod;
  /** Receita: antigo (euros × 100, para comparar em cêntimos) × canónico. */
  legacyRevenueCents: number;
  canonicalPerformedCents: number | null;
  revenueDriftCents: number;
  /** Absentismo: antigo × canónico (dias). */
  legacyAbsenceDays: number;
  canonicalAbsenceDays: number;
  absenceDriftDays: number;
  /** Absentismo antigo acima do máximo possível para o período. */
  absenceImpossible: boolean;
  /** Contagem no balde "agendado" que o canónico separa. */
  legacyBucketedCount: number;
  canonicalBucketedCount: number;
  /** Dias com valor na série antiga × dias do período. */
  legacyDaysInSeries: number;
  periodDayCount: number;
  reasons: DivergenceReason[];
  diverges: boolean;
}

export interface ReportsCompatSummary {
  totalCases: number;
  unchanged: number;
  changed: number;
  totalRevenueDriftCents: number;
  totalAbsenceDriftDays: number;
  casesWithImpossibleAbsence: number;
  casesWithInvisibleMonthly: number;
  casesWithBucketedStatus: number;
  casesWithMissingEmptyDays: number;
  byReason: Record<DivergenceReason, number>;
  worstRevenueDriftLabel: string | null;
  worstRevenueDriftCents: number;
}

export interface ReportsCompatReport {
  summary: ReportsCompatSummary;
  cases: CaseComparison[];
}

// ─── Construção das fixtures ────────────────────────────────────────────────

function cents(euros: number): MoneyCents {
  const c = eurosToCents(euros);
  if (c == null) throw new RangeError(`valor inválido: ${euros}`);
  return c;
}

const CONTRACT_ID = "contrato-sintetico";

function buildFixture(c: ReportCase): {
  window: CivilPeriod;
  services: ServiceInput[];
  contracts: ContractInput[];
  monthly: MonthlyOccurrenceSet[];
  absences: AbsenceInput[];
} {
  const window = monthPeriod(c.year, c.month);
  if (!window) throw new RangeError(`mês inválido: ${c.year}-${c.month}`);

  const monthKey = window.start.slice(0, 7);
  const services: ServiceInput[] = [];

  c.avencaStatuses.forEach((status, i) => {
    const day = String(Math.min(28, i + 1)).padStart(2, "0");
    services.push({
      id: `avenca-${i}`,
      occurrenceDate: `${monthKey}-${day}`,
      status,
      contractId: CONTRACT_ID,
      // Ocorrência de avença vale 0 na base — é assim por desenho.
      valueCents: cents(0),
      applyVat: c.applyVat,
      workedMinutes: null,
      scheduledMinutes: 120,
    });
  });

  c.adhoc.forEach(([status, euros], i) => {
    const day = String(Math.min(28, i + 1)).padStart(2, "0");
    services.push({
      id: `avulso-${i}`,
      occurrenceDate: `${monthKey}-${day}`,
      status,
      contractId: null,
      valueCents: cents(euros),
      applyVat: c.applyVat,
      workedMinutes: null,
      scheduledMinutes: 90,
    });
  });

  const contracts: ContractInput[] = c.monthlyPriceEuros == null
    ? []
    : [{
        id: CONTRACT_ID,
        fixedMonthly: true,
        fixedPriceCents: cents(c.monthlyPriceEuros),
        applyVat: c.applyVat,
        startsOn: null,
        endsOn: null,
        status: "ativo",
      }];

  const monthly: MonthlyOccurrenceSet[] = c.monthlyPriceEuros == null
    ? []
    : [{
        contractId: CONTRACT_ID,
        monthKey,
        occurrences: services
          .filter((s) => s.contractId === CONTRACT_ID)
          .map((s) => ({
            id: s.id,
            occurrenceDate: s.occurrenceDate,
            status: s.status as "agendado" | "em_curso" | "concluido" | "cancelado" | "falta",
          })),
      }];

  const absences: AbsenceInput[] = c.absences.map(([startsOn, endsOn], i) => ({
    id: `ausencia-${i}`,
    collaboratorId: `colaborador-${i}`,
    type: "doenca_com_baixa",
    startsOn,
    endsOn,
  }));

  return { window, services, contracts, monthly, absences };
}

// ─── Comparação ─────────────────────────────────────────────────────────────

export function compareCase(c: ReportCase): CaseComparison {
  const { window, services, contracts, monthly, absences } = buildFixture(c);

  const canonical: ReportReadModel = buildReport({
    window,
    asOf: window.end,
    sources: {
      services: sourceOk(services),
      contracts: sourceOk(contracts),
      invoices: sourceOk([]),
      cashFlow: sourceOk([]),
      payroll: sourceOk([]),
      timesheets: sourceOk([]),
      absences: sourceOk(absences),
      vat: sourceOk([{ ratePct: c.vatRatePct }]),
    },
    monthlyOccurrences: monthly,
  });

  // ── Receita ──
  const legacyRevenueCents = Math.round(legacyRevenueFromServices(services) * 100);
  const canonicalPerformedCents = canonical.financial.performed.cents;
  const revenueDriftCents = (canonicalPerformedCents ?? 0) - legacyRevenueCents;

  // ── Absentismo ──
  const legacyDays = legacyTotalAbsenceDays(absences);
  const canonicalDays = totalAbsenceDays(summariseAbsences(absences, window).contributions);
  const absenceDriftDays = canonicalDays - legacyDays;
  const absenceImpossible = legacyDays > periodDays(window) * Math.max(1, absences.length);

  // ── Estados ──
  const legacyCounts = legacyCountServices(services);
  const canonicalCounts = countServices(services, window).counts;
  const canonicalBucketedCount =
    canonicalCounts.agendado + canonicalCounts.em_curso + canonicalCounts.sem_cobertura;

  // ── Série diária ──
  const priceMap = new Map<string, number>();
  const vatMap = new Map<string, boolean>();
  if (c.monthlyPriceEuros != null) {
    priceMap.set(CONTRACT_ID, c.monthlyPriceEuros);
    vatMap.set(CONTRACT_ID, c.applyVat);
  }
  const legacySeries = legacyDailyTotals(services, priceMap, vatMap, c.vatRatePct);

  // ── Razões ──
  const reasons: DivergenceReason[] = [];
  if (
    c.monthlyPriceEuros != null
    && c.monthlyPriceEuros > 0
    && c.avencaStatuses.includes("concluido")
    && legacyRevenueCents === 0
  ) {
    reasons.push("MONTHLY_INVISIBLE_IN_REVENUE");
  }
  if (
    c.monthlyPriceEuros != null
    && c.avencaStatuses.length > 1
    && cents(c.monthlyPriceEuros) % c.avencaStatuses.length !== 0
  ) {
    reasons.push("CENTS_LOST_IN_SPLIT");
  }
  if (absenceDriftDays !== 0) reasons.push("ABSENCE_OVERCOUNTED");
  if (legacyCounts.agendado !== canonicalCounts.agendado) reasons.push("STATUS_BUCKETED");
  if (legacySeries.size < periodDays(window)) reasons.push("EMPTY_DAYS_MISSING");
  if (c.applyVat && c.adhoc.length > 1) reasons.push("VAT_ON_AGGREGATE");

  return {
    label: c.label,
    window,
    legacyRevenueCents,
    canonicalPerformedCents,
    revenueDriftCents,
    legacyAbsenceDays: legacyDays,
    canonicalAbsenceDays: canonicalDays,
    absenceDriftDays,
    absenceImpossible,
    legacyBucketedCount: legacyCounts.agendado,
    canonicalBucketedCount,
    legacyDaysInSeries: legacySeries.size,
    periodDayCount: periodDays(window),
    reasons,
    diverges: reasons.length > 0 || revenueDriftCents !== 0 || absenceDriftDays !== 0,
  };
}

export function compareReportCases(cases: readonly ReportCase[]): ReportsCompatReport {
  const results = cases.map(compareCase);

  const byReason: Record<DivergenceReason, number> = {
    CENTS_LOST_IN_SPLIT: 0,
    MONTHLY_INVISIBLE_IN_REVENUE: 0,
    ABSENCE_OVERCOUNTED: 0,
    STATUS_BUCKETED: 0,
    EMPTY_DAYS_MISSING: 0,
    VAT_ON_AGGREGATE: 0,
  };

  let totalRevenueDriftCents = 0;
  let totalAbsenceDriftDays = 0;
  let worstRevenueDriftLabel: string | null = null;
  let worstRevenueDriftCents = 0;

  for (const r of results) {
    for (const reason of r.reasons) byReason[reason] += 1;
    totalRevenueDriftCents += r.revenueDriftCents;
    totalAbsenceDriftDays += r.absenceDriftDays;
    if (Math.abs(r.revenueDriftCents) > Math.abs(worstRevenueDriftCents)) {
      worstRevenueDriftCents = r.revenueDriftCents;
      worstRevenueDriftLabel = r.label;
    }
  }

  const changed = results.filter((r) => r.diverges).length;

  return {
    summary: {
      totalCases: results.length,
      unchanged: results.length - changed,
      changed,
      totalRevenueDriftCents,
      totalAbsenceDriftDays,
      casesWithImpossibleAbsence: results.filter((r) => r.absenceImpossible).length,
      casesWithInvisibleMonthly: byReason.MONTHLY_INVISIBLE_IN_REVENUE,
      casesWithBucketedStatus: byReason.STATUS_BUCKETED,
      casesWithMissingEmptyDays: byReason.EMPTY_DAYS_MISSING,
      byReason,
      worstRevenueDriftLabel,
      worstRevenueDriftCents,
    },
    cases: results,
  };
}

// ─── Matriz determinística ──────────────────────────────────────────────────

/**
 * Cenários sintéticos que cobrem cada classe de divergência conhecida.
 *
 * Determinística de propósito: dois computadores diferentes têm de obter
 * exactamente o mesmo relatório, senão o comparador não serve como prova.
 */
export function defaultReportMatrix(vatRatePct = 23): ReportCase[] {
  const base = { year: 2026, month: 8, vatRatePct };
  const cases: ReportCase[] = [];

  // 1. Mês vazio.
  cases.push({
    ...base,
    label: "mês vazio",
    monthlyPriceEuros: null,
    applyVat: false,
    avencaStatuses: [],
    adhoc: [],
    absences: [],
  });

  // 2. Avença que não divide certo — cêntimos perdidos.
  for (const [price, count] of [[100, 3], [99.99, 31], [300, 7], [250, 6]] as const) {
    cases.push({
      ...base,
      label: `avença ${price} € ÷ ${count} concluídos`,
      monthlyPriceEuros: price,
      applyVat: true,
      avencaStatuses: Array.from({ length: count }, () => "concluido"),
      adhoc: [],
      absences: [],
    });
  }

  // 3. Avença sem nenhuma ocorrência concluída.
  cases.push({
    ...base,
    label: "avença sem visita concluída",
    monthlyPriceEuros: 300,
    applyVat: true,
    avencaStatuses: ["agendado", "agendado"],
    adhoc: [],
    absences: [],
  });

  // 4. Avença sem ocorrências de todo.
  cases.push({
    ...base,
    label: "avença sem ocorrências no mês",
    monthlyPriceEuros: 300,
    applyVat: true,
    avencaStatuses: [],
    adhoc: [],
    absences: [],
  });

  // 5. Estados que o balde antigo agrupa.
  cases.push({
    ...base,
    label: "estados em_curso e sem_cobertura",
    monthlyPriceEuros: null,
    applyVat: true,
    avencaStatuses: [],
    adhoc: [
      ["agendado", 50],
      ["em_curso", 50],
      ["sem_cobertura", 50],
      ["concluido", 50],
      ["cancelado", 50],
      ["falta", 50],
    ],
    absences: [],
  });

  // 6. Ausências a atravessar a fronteira do mês.
  cases.push({
    ...base,
    label: "ausência a começar antes do mês",
    monthlyPriceEuros: null,
    applyVat: false,
    avencaStatuses: [],
    adhoc: [],
    absences: [["2026-07-20", "2026-08-05"]],
  });
  cases.push({
    ...base,
    label: "ausência a terminar depois do mês",
    monthlyPriceEuros: null,
    applyVat: false,
    avencaStatuses: [],
    adhoc: [],
    absences: [["2026-08-25", "2026-09-10"]],
  });
  cases.push({
    ...base,
    label: "ausência a cobrir dois meses inteiros",
    monthlyPriceEuros: null,
    applyVat: false,
    avencaStatuses: [],
    adhoc: [],
    absences: [["2026-08-01", "2026-09-30"]],
  });
  cases.push({
    ...base,
    label: "ausência inteiramente dentro do mês",
    monthlyPriceEuros: null,
    applyVat: false,
    avencaStatuses: [],
    adhoc: [],
    absences: [["2026-08-10", "2026-08-12"]],
  });

  // 7. Serviços avulsos com IVA — a soma no CSV.
  cases.push({
    ...base,
    label: "avulsos com IVA linha a linha",
    monthlyPriceEuros: null,
    applyVat: true,
    avencaStatuses: [],
    adhoc: [
      ["concluido", 33.33],
      ["concluido", 33.33],
      ["concluido", 33.34],
    ],
    absences: [],
  });

  // 8. Mês com mudança de hora (DST em Portugal: último domingo de outubro).
  cases.push({
    year: 2026,
    month: 10,
    vatRatePct,
    label: "mês com fim da hora de verão",
    monthlyPriceEuros: 100,
    applyVat: true,
    avencaStatuses: ["concluido", "concluido", "concluido"],
    adhoc: [["concluido", 40]],
    absences: [["2026-10-24", "2026-10-27"]],
  });

  // 9. Mês de fevereiro (28 dias) e ano bissexto.
  cases.push({
    year: 2026, month: 2, vatRatePct,
    label: "fevereiro de ano comum",
    monthlyPriceEuros: 100, applyVat: true,
    avencaStatuses: ["concluido", "concluido", "concluido"],
    adhoc: [], absences: [["2026-02-25", "2026-03-05"]],
  });
  cases.push({
    year: 2028, month: 2, vatRatePct,
    label: "fevereiro de ano bissexto",
    monthlyPriceEuros: 100, applyVat: true,
    avencaStatuses: ["concluido", "concluido", "concluido"],
    adhoc: [], absences: [["2028-02-25", "2028-03-05"]],
  });

  // 10. Avença com faltas e cancelamentos misturados.
  cases.push({
    ...base,
    label: "avença com falta e cancelamento",
    monthlyPriceEuros: 200,
    applyVat: true,
    avencaStatuses: ["concluido", "falta", "cancelado", "concluido"],
    adhoc: [],
    absences: [],
  });

  return cases;
}
