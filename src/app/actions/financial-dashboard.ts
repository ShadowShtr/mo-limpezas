"use server";

import { createAdminClient } from "@/lib/supabase/admin";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface MonthlyFinancial {
  year: number;
  month: number;
  label: string;
  revenue: number;
  costs: number;
  margin: number;
}

export interface ClientRevenue {
  client_id: string;
  client_name: string;
  total: number;
}

export interface FinancialDashboardData {
  currentMonthRevenue: number;
  currentMonthCosts: number;
  currentMonthMargin: number;
  currentMonthMarginPct: number;
  yearRevenue: number;
  yearCosts: number;
  yearMargin: number;
  pendingRevenue: number;
  projectedAnnualRevenue: number;
  monthly: MonthlyFinancial[];
  byClient: ClientRevenue[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function last12Months(): { year: number; month: number }[] {
  const result: { year: number; month: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return result;
}

// ─── Action principal ─────────────────────────────────────────────────────────

export async function getFinancialDashboard(
  companyId: string,
): Promise<{ ok: true; data: FinancialDashboardData } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const months = last12Months();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // Período coberto pelos últimos 12 meses
  const oldest = months[0];
  const periodStart = `${oldest.year}-${String(oldest.month).padStart(2, "0")}-01`;

  // ── Invoices dos últimos 12 meses ──────────────────────────────────────────
  const { data: invoices, error: iErr } = await admin
    .from("invoices")
    .select("client_id, total, status, period_start, clients(name)")
    .eq("company_id", companyId)
    .neq("status", "cancelado")
    .gte("period_start", periodStart);

  if (iErr) return { ok: false, error: iErr.message };

  // ── Payroll dos últimos 12 meses ────────────────────────────────────────────
  const { data: payroll, error: pErr } = await admin
    .from("payroll_records")
    .select("period_year, period_month, net_salary")
    .eq("company_id", companyId)
    .or(
      months.map((m) => `and(period_year.eq.${m.year},period_month.eq.${m.month})`).join(","),
    );

  if (pErr) return { ok: false, error: pErr.message };

  // ── Agregar por mês ────────────────────────────────────────────────────────
  const monthly: MonthlyFinancial[] = months.map(({ year, month }) => {
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;

    const revenue = (invoices ?? [])
      .filter((inv) => inv.period_start?.startsWith(monthStr))
      .reduce((s, inv) => s + (inv.total ?? 0), 0);

    const costs = (payroll ?? [])
      .filter((r) => r.period_year === year && r.period_month === month)
      .reduce((s, r) => s + (r.net_salary ?? 0), 0);

    return {
      year,
      month,
      label: `${MONTH_LABELS[month - 1]} ${String(year).slice(2)}`,
      revenue: Math.round(revenue * 100) / 100,
      costs: Math.round(costs * 100) / 100,
      margin: Math.round((revenue - costs) * 100) / 100,
    };
  });

  // ── KPIs do mês atual ──────────────────────────────────────────────────────
  const currentMonthData = monthly.find((m) => m.year === currentYear && m.month === currentMonth);
  const currentMonthRevenue = currentMonthData?.revenue ?? 0;
  const currentMonthCosts   = currentMonthData?.costs   ?? 0;
  const currentMonthMargin  = currentMonthData?.margin  ?? 0;
  const currentMonthMarginPct = currentMonthRevenue > 0
    ? Math.round((currentMonthMargin / currentMonthRevenue) * 100)
    : 0;

  // ── KPIs do ano atual ──────────────────────────────────────────────────────
  const yearMonths = monthly.filter((m) => m.year === currentYear);
  const yearRevenue = Math.round(yearMonths.reduce((s, m) => s + m.revenue, 0) * 100) / 100;
  const yearCosts   = Math.round(yearMonths.reduce((s, m) => s + m.costs,   0) * 100) / 100;
  const yearMargin  = Math.round((yearRevenue - yearCosts) * 100) / 100;

  // ── Receita pendente (faturas pendentes + vencidas) ────────────────────────
  const pendingRevenue = Math.round(
    (invoices ?? [])
      .filter((inv) => inv.status === "pendente" || inv.status === "vencido")
      .reduce((s, inv) => s + (inv.total ?? 0), 0) * 100,
  ) / 100;

  // ── Projeção anual (média dos meses com dados × 12) ────────────────────────
  const monthsWithRevenue = yearMonths.filter((m) => m.revenue > 0 && m.month < currentMonth);
  const avgMonthlyRevenue = monthsWithRevenue.length > 0
    ? yearRevenue / monthsWithRevenue.length
    : 0;
  const remainingMonths = 12 - currentMonth;
  const projectedAnnualRevenue = Math.round(
    (yearRevenue + avgMonthlyRevenue * remainingMonths) * 100,
  ) / 100;

  // ── Receita por cliente (ano atual) ────────────────────────────────────────
  const clientMap = new Map<string, { name: string; total: number }>();
  for (const inv of invoices ?? []) {
    const periodYear = inv.period_start ? Number(inv.period_start.slice(0, 4)) : 0;
    if (periodYear !== currentYear) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = ((inv as any).clients as { name: string } | null)?.name ?? "—";
    const existing = clientMap.get(inv.client_id) ?? { name, total: 0 };
    clientMap.set(inv.client_id, { name, total: existing.total + (inv.total ?? 0) });
  }
  const byClient: ClientRevenue[] = [...clientMap.entries()]
    .map(([client_id, { name, total }]) => ({
      client_id,
      client_name: name,
      total: Math.round(total * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    ok: true,
    data: {
      currentMonthRevenue,
      currentMonthCosts,
      currentMonthMargin,
      currentMonthMarginPct,
      yearRevenue,
      yearCosts,
      yearMargin,
      pendingRevenue,
      projectedAnnualRevenue,
      monthly,
      byClient,
    },
  };
}
