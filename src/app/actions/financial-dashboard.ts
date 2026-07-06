"use server";

import { requireProfile } from "@/lib/auth-guard";
import { todayInLisbon, addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";

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

// ─── Resumo operacional (dia / semana / mês, direto do calendário) ────────────

export interface PeriodSummary {
  /** Valor total previsto (serviços não cancelados no período, c/ IVA quando aplicável) */
  expected: number;
  /** Valor dos serviços já concluídos */
  done: number;
  services: number;
  concluded: number;
}

/** Linha individual para a lista de conferência (clicar num cartão). */
export interface SummaryServiceRow {
  id: string;
  /** YYYY-MM-DD */
  day: string;
  client_name: string;
  location_name: string;
  /** Valor c/ IVA quando aplicável (avenças: fatia mensal ÷ serviços do mês) */
  value: number;
  status: string;
  is_avenca: boolean;
}

export interface OperationalSummary {
  today: PeriodSummary;
  week: PeriodSummary;
  month: PeriodSummary;
  /** Todos os serviços do intervalo (semana ∪ mês) para o detalhe por período. */
  rows: SummaryServiceRow[];
  /** Limites dos períodos (YYYY-MM-DD) para filtrar as rows no cliente. */
  bounds: { today: string; weekStart: string; weekEnd: string; monthStart: string; monthEnd: string };
  vatRate: number;
}

/**
 * Resumo do dia/semana/mês calculado DIRETO da tabela services (o calendário):
 * criar um card no calendário aparece aqui de imediato; apagar, desaparece.
 * Avenças (fixed_monthly): o valor mensal é dividido pelos serviços do mês.
 */
export async function getOperationalSummary(): Promise<
  { ok: true; data: OperationalSummary } | { ok: false; error: string }
> {
  try {
    return await _getOperationalSummary();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Erro ao carregar resumo." };
  }
}

async function _getOperationalSummary(): Promise<
  { ok: true; data: OperationalSummary } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  // todayInLisbon() usa Intl (Europe/Lisbon) em vez de `new Date()` local —
  // essencial porque o servidor (Vercel) corre em UTC por omissão, sem TZ
  // configurada, e "hoje"/"esta semana" têm de refletir o dia real em Lisboa.
  const todayStr = todayInLisbon();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  // Dia da semana da data (calendário puro via Date.UTC — não depende do
  // fuso do processo, só da data já correta em Lisboa).
  const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
  // Semana: segunda a domingo
  const weekStartStr = addDaysToDateString(todayStr, -((dow + 6) % 7));
  const weekEndStr = addDaysToDateString(weekStartStr, 6);
  // Mês
  const monthStartStr = `${todayStr.slice(0, 7)}-01`;
  const monthEndDay = new Date(ty, tm, 0).getDate();
  const monthEndStr = `${todayStr.slice(0, 7)}-${String(monthEndDay).padStart(2, "0")}`;

  // Intervalo mais largo que cobre os três períodos (a semana pode atravessar meses)
  const rangeStart = weekStartStr < monthStartStr ? weekStartStr : monthStartStr;
  const rangeEnd = weekEndStr > monthEndStr ? weekEndStr : monthEndStr;
  const rangeEndExclusive = addDaysToDateString(rangeEnd, 1);

  const [{ data: services, error: sErr }, { data: settingsRow }] = await Promise.all([
    admin
      .from("services")
      .select("id, location_id, contract_id, calculated_value, manual_value, apply_vat, status, scheduled_start")
      .eq("company_id", companyId)
      .neq("status", "cancelado")
      .gte("scheduled_start", toLisbonTimestamp(rangeStart, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(rangeEndExclusive, "00:00")),
    admin.from("company_settings").select("vat_rate").eq("company_id", companyId).single(),
  ]);
  if (sErr) return { ok: false, error: sErr.message };

  // Nomes de local/cliente para a lista de conferência
  const locationIds = [...new Set((services ?? []).map((s) => s.location_id).filter(Boolean))];
  const { data: locations } = locationIds.length > 0
    ? await admin.from("locations").select("id, name, clients(name)").in("id", locationIds)
    : { data: [] };
  const locMap = Object.fromEntries(
    (locations ?? []).map((l) => {
      const client = l.clients as unknown as { name: string } | null;
      return [l.id, { name: l.name as string, clientName: client?.name ?? "—" }];
    }),
  );

  const vatRate: number = settingsRow?.vat_rate ?? 23;
  const vatFactor = vatRate / 100;

  // Avenças: valor mensal ÷ serviços do mês (por contrato e por mês do intervalo)
  const contractIds = [...new Set((services ?? []).map((s) => s.contract_id).filter(Boolean))] as string[];
  const { data: contracts } = contractIds.length > 0
    ? await admin.from("contracts").select("id, fixed_monthly, fixed_price, apply_vat").in("id", contractIds)
    : { data: [] as { id: string; fixed_monthly: boolean; fixed_price: number | null; apply_vat: boolean }[] };
  const contractMap = Object.fromEntries((contracts ?? []).map((c) => [c.id, c]));

  const avencaCount = new Map<string, number>(); // `${contractId}|${YYYY-MM}`
  for (const s of services ?? []) {
    if (!s.contract_id || !contractMap[s.contract_id]?.fixed_monthly) continue;
    const key = `${s.contract_id}|${s.scheduled_start.slice(0, 7)}`;
    avencaCount.set(key, (avencaCount.get(key) ?? 0) + 1);
  }

  function valueOf(s: NonNullable<typeof services>[number]): number {
    const contract = s.contract_id ? contractMap[s.contract_id] : null;
    if (contract?.fixed_monthly) {
      const count = avencaCount.get(`${s.contract_id}|${s.scheduled_start.slice(0, 7)}`) ?? 1;
      const base = (contract.fixed_price ?? 0) / Math.max(1, count);
      return base * (contract.apply_vat === true ? 1 + vatFactor : 1);
    }
    const base = s.manual_value ?? s.calculated_value ?? 0;
    return base * (s.apply_vat !== false ? 1 + vatFactor : 1);
  }

  const empty = (): PeriodSummary => ({ expected: 0, done: 0, services: 0, concluded: 0 });
  const today = empty(), week = empty(), month = empty();

  const rows: SummaryServiceRow[] = [];
  for (const s of services ?? []) {
    const day = s.scheduled_start.slice(0, 10);
    const v = valueOf(s);
    const buckets: PeriodSummary[] = [];
    if (day === todayStr) buckets.push(today);
    if (day >= weekStartStr && day <= weekEndStr) buckets.push(week);
    if (day >= monthStartStr && day <= monthEndStr) buckets.push(month);
    for (const b of buckets) {
      b.expected += v;
      b.services += 1;
      if (s.status === "concluido") { b.done += v; b.concluded += 1; }
    }
    const loc = locMap[s.location_id] ?? { name: "—", clientName: "—" };
    rows.push({
      id: s.id,
      day,
      client_name: loc.clientName,
      location_name: loc.name,
      value: Math.round(v * 100) / 100,
      status: s.status,
      is_avenca: s.contract_id != null && contractMap[s.contract_id]?.fixed_monthly === true,
    });
  }

  const round = (b: PeriodSummary): PeriodSummary => ({
    expected: Math.round(b.expected * 100) / 100,
    done: Math.round(b.done * 100) / 100,
    services: b.services,
    concluded: b.concluded,
  });

  return {
    ok: true,
    data: {
      today: round(today),
      week: round(week),
      month: round(month),
      rows,
      bounds: {
        today: todayStr,
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        monthStart: monthStartStr,
        monthEnd: monthEndStr,
      },
      vatRate,
    },
  };
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
  _companyId?: string,
): Promise<{ ok: true; data: FinancialDashboardData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  // company_id vem SEMPRE da sessão — nunca confiar no parâmetro do cliente.
  const companyId = profile.company_id;
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
