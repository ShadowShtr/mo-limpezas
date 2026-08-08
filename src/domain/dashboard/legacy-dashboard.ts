// ============================================================================
// T15 — O dashboard antigo, capturado tal como está
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro, só para comparação. Não toca em dados nem em runtime.
//
// ----------------------------------------------------------------------------
//
// Mesma razão da T11 (`legacy-formulas.ts`) e da T14 (`legacy-reports.ts`):
// para medir a diferença é preciso ter os dois lados no mesmo sítio.
//
// Cada função aponta a linha de onde foi transcrita. **Não importar em código
// de aplicação** — uma guarda estática garante-o.

/** Réplica do arredondamento que o dashboard usa por todo o lado. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface LegacyInvoiceRow {
  /** `invoices.total` — COM IVA. */
  total: number;
  /** `invoices.status`. */
  status: string;
  /** `invoices.period_start`, "YYYY-MM-DD". */
  periodStart: string;
  clientId: string;
}

export interface LegacyPayrollRow {
  periodYear: number;
  periodMonth: number;
  netSalary: number;
}

export interface LegacyMonthlyRow {
  year: number;
  month: number;
  revenue: number;
  costs: number;
  margin: number;
}

/**
 * `getFinancialDashboard`, agregação mensal (~linha 277).
 *
 * Dois pontos a reter:
 *
 *   1. `revenue` soma `invoices.total`, que é o valor **COM IVA**;
 *   2. a consulta que a alimenta filtra só `.neq("status", "cancelado")` — ou
 *      seja, **rascunhos contam como receita**.
 *
 * `costs` soma apenas `payroll_records.net_salary`. As despesas de
 * `cash_flow_entries` não entram em lado nenhum do dashboard.
 */
export function legacyMonthlyAggregation(
  invoices: readonly LegacyInvoiceRow[],
  payroll: readonly LegacyPayrollRow[],
  months: readonly { year: number; month: number }[],
): LegacyMonthlyRow[] {
  return months.map(({ year, month }) => {
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;

    const revenue = invoices
      .filter((inv) => inv.status !== "cancelado")
      .filter((inv) => inv.periodStart.startsWith(monthStr))
      .reduce((s, inv) => s + inv.total, 0);

    const costs = payroll
      .filter((r) => r.periodYear === year && r.periodMonth === month)
      .reduce((s, r) => s + r.netSalary, 0);

    return {
      year,
      month,
      revenue: round2(revenue),
      costs: round2(costs),
      margin: round2(revenue - costs),
    };
  });
}

/**
 * `getFinancialDashboard`, "Receita pendente" (~linha 314).
 *
 * Soma as faturas com `status` textual `pendente` ou `vencido` sobre **toda a
 * janela de 12 meses**, não sobre o mês do cartão. E usa o texto do estado em
 * vez de comparar `due_date` com a data de referência — uma fatura vencida cujo
 * estado ainda não foi actualizado não aparece.
 */
export function legacyPendingRevenue(invoices: readonly LegacyInvoiceRow[]): number {
  return round2(
    invoices
      .filter((inv) => inv.status === "pendente" || inv.status === "vencido")
      .reduce((s, inv) => s + inv.total, 0),
  );
}

/**
 * `getFinancialDashboard`, receita por cliente (~linha 331).
 *
 * Ano corrente, `invoices.total` (com IVA, com rascunhos), top 8. Um cliente
 * sem fatura emitida **não aparece**, mesmo com serviços realizados no ano.
 */
export function legacyClientRevenue(
  invoices: readonly LegacyInvoiceRow[],
  currentYear: number,
  limit = 8,
): { clientId: string; total: number }[] {
  const map = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status === "cancelado") continue;
    if (Number(inv.periodStart.slice(0, 4)) !== currentYear) continue;
    map.set(inv.clientId, (map.get(inv.clientId) ?? 0) + inv.total);
  }
  return [...map.entries()]
    .map(([clientId, total]) => ({ clientId, total: round2(total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * `getFinancialDashboard`, percentagem de margem do mês (~linha 303).
 *
 *     revenue > 0 ? round((margin / revenue) * 100) : 0
 *
 * Devolve **0%** quando não há receita — mesmo com margem negativa. O 0% não é
 * a percentagem: é a ausência dela, disfarçada de valor.
 */
export function legacyMarginPct(margin: number, revenue: number): number {
  return revenue > 0 ? Math.round((margin / revenue) * 100) : 0;
}

/**
 * `MonthlyTable` em `financial-dashboard-client.tsx` (~linha 183). Mesma
 * fórmula, reimplementada no cliente — duas cópias da mesma decisão.
 */
export function legacyTableMarginPct(margin: number, revenue: number): number {
  return revenue > 0 ? Math.round((margin / revenue) * 100) : 0;
}

/**
 * `RevenueChart`, linha de margem (~linha 108).
 *
 *     const marginPct = Math.max(m.margin, 0) / maxVal;
 *
 * Uma margem **negativa** é achatada em zero e desenhada na linha de base,
 * indistinguível de um mês com margem exactamente zero. O mês em que a empresa
 * perdeu dinheiro tem o mesmo aspecto do mês em que ficou empatada.
 */
export function legacyMarginChartValue(margin: number, maxVal: number): number {
  return Math.max(margin, 0) / Math.max(maxVal, 1);
}

/**
 * `getFinancialDashboard`, projecção anual (~linha 320).
 *
 * Ver a decomposição completa em `src/domain/dashboard/projection.ts`. Resumo:
 * o numerador é o total do ano (incluindo o mês corrente, incompleto) e o
 * denominador só conta os meses ANTERIORES com receita > 0.
 */
export function legacyProjectedAnnual(
  monthly: readonly LegacyMonthlyRow[],
  currentYear: number,
  currentMonth: number,
): number {
  const yearMonths = monthly.filter((m) => m.year === currentYear);
  const yearRevenue = round2(yearMonths.reduce((s, m) => s + m.revenue, 0));
  const monthsWithRevenue = yearMonths.filter((m) => m.revenue > 0 && m.month < currentMonth);
  const avgMonthlyRevenue = monthsWithRevenue.length > 0
    ? yearRevenue / monthsWithRevenue.length
    : 0;
  const remainingMonths = 12 - currentMonth;
  return round2(yearRevenue + avgMonthlyRevenue * remainingMonths);
}

/**
 * `getOperationalSummary`, `valueOf` (~linha 157).
 *
 * O valor dos cartões "Hoje / Esta semana / Este mês". Note-se que é uma
 * grandeza **completamente diferente** da do KPI "Receita" no mesmo ecrã:
 * parte de `services`, não de `invoices`, e divide a avença por um denominador
 * tirado dos serviços que já estavam em memória (defeito §4.3 da T11).
 *
 * Nada na página explica ao utilizador porque é que os dois números discordam.
 */
export function legacyOperationalValue(input: {
  fixedPrice: number | null;
  isAvenca: boolean;
  countInMemory: number;
  serviceValue: number;
  applyVat: boolean;
  vatRatePct: number;
}): number {
  const factor = input.vatRatePct / 100;
  if (input.isAvenca) {
    const base = (input.fixedPrice ?? 0) / Math.max(1, input.countInMemory);
    return base * (input.applyVat ? 1 + factor : 1);
  }
  return input.serviceValue * (input.applyVat ? 1 + factor : 1);
}
