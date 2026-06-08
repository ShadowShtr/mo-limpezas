"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PayrollRecord {
  id: string;
  collaborator_id: string;
  full_name: string;
  avatar_url: string | null;
  period_year: number;
  period_month: number;
  contracted_hours: number;
  worked_hours: number;
  overtime_hours: number;
  absence_hours: number;
  days_worked: number;
  hourly_rate: number;
  gross_salary: number;
  meal_allowance: number;
  overtime_bonus: number;
  absence_deductions: number;
  other_deductions: number;
  other_additions: number;
  net_salary: number;
  notes: string | null;
  status: "rascunho" | "aprovado" | "pago";
  paid_at: string | null;
}

export interface PayrollAdjust {
  other_additions?:    number;
  other_deductions?:   number;
  notes?:              string;
  worked_hours?:       number;
  overtime_hours?:     number;
  absence_hours?:      number;
  absence_deductions?: number;
  days_worked?:        number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().split("T")[0];
  return { start, end };
}

// ─── Calcular e guardar folha de pagamento ────────────────────────────────────

export async function calculateAndSavePayroll(
  companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; records: PayrollRecord[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { start, end } = monthRange(year, month);

  // 1. Colaboradores ativos
  const { data: profiles, error: pErr } = await admin
    .from("profiles")
    .select("id, full_name, avatar_url, contracted_hours_month, hourly_rate")
    .eq("company_id", companyId)
    .in("role", ["colaborador", "gestor"])
    .eq("status", "ativo")
    .order("full_name");

  if (pErr) return { ok: false, error: pErr.message };
  if (!profiles?.length) return { ok: true, records: [] };

  // 2. Configurações da empresa (salário/hora e sub. alimentação por defeito)
  const { data: settings } = await admin
    .from("company_settings")
    .select("hourly_rate, meal_allowance_day, overtime_rate_pct")
    .eq("company_id", companyId)
    .single();

  const defaultHourlyRate = settings?.hourly_rate ?? 8;
  const mealAllowanceDay  = settings?.meal_allowance_day ?? 9.6;
  const overtimeRatePct   = settings?.overtime_rate_pct ?? 25;

  const profileIds = profiles.map((p) => p.id);

  // 3. Timesheets do mês
  const { data: timesheets } = await admin
    .from("timesheets")
    .select("collaborator_id, duration_minutes, clock_in_at")
    .eq("company_id", companyId)
    .in("collaborator_id", profileIds)
    .gte("clock_in_at", `${start}T00:00:00`)
    .lte("clock_in_at", `${end}T23:59:59`);

  // 4. Faltas do mês
  const { data: absences } = await admin
    .from("absences")
    .select("collaborator_id, absence_type, starts_on, ends_on")
    .eq("company_id", companyId)
    .in("collaborator_id", profileIds)
    .lte("starts_on", end)
    .gte("ends_on", start);

  // 5. Registos existentes (para preservar ajustes manuais)
  const { data: existing } = await admin
    .from("payroll_records")
    .select("collaborator_id, other_additions, other_deductions, notes, status, paid_at")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month);

  const existingMap = Object.fromEntries(
    (existing ?? []).map((r) => [r.collaborator_id, r]),
  );

  // 6. Calcular por colaborador
  const upserts = profiles.map((p) => {
    const myTimesheets = (timesheets ?? []).filter((t) => t.collaborator_id === p.id);
    const workedMinutes = myTimesheets.reduce((s, t) => s + (t.duration_minutes ?? 0), 0);
    const workedHours = Math.round((workedMinutes / 60) * 100) / 100;

    // Dias trabalhados = datas distintas
    const datesSet = new Set(
      myTimesheets
        .filter((t) => t.clock_in_at)
        .map((t) => (t.clock_in_at as string).slice(0, 10)),
    );
    const daysWorked = datesSet.size;

    const contractedHours = p.contracted_hours_month ?? 168;
    const hourlyRate = p.hourly_rate ?? defaultHourlyRate;

    // Horas extra = acima do contratado
    const overtimeHours = Math.max(0, Math.round((workedHours - contractedHours) * 100) / 100);

    // Faltas: total de dias no mês com sobreposição
    const myAbsences = (absences ?? []).filter((a) => a.collaborator_id === p.id);
    let absenceDays = 0;
    let injustifiedDays = 0;
    for (const a of myAbsences) {
      const aStart = new Date(Math.max(new Date(a.starts_on).getTime(), new Date(start).getTime()));
      const aEnd   = new Date(Math.min(new Date(a.ends_on).getTime(),   new Date(end).getTime()));
      const days = Math.round((aEnd.getTime() - aStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (days > 0) {
        absenceDays += days;
        if (a.absence_type === "pessoal_injustificado") injustifiedDays += days;
      }
    }
    // Horas de falta = dias × (horas contratadas / 22 dias úteis estimados)
    const dailyHours = contractedHours / 22;
    const absenceHours  = Math.round(absenceDays * dailyHours * 100) / 100;
    const absenceDeductions = Math.round(injustifiedDays * dailyHours * hourlyRate * 100) / 100;

    const grossSalary   = Math.round(workedHours * hourlyRate * 100) / 100;
    const mealAllowance = Math.round(daysWorked * mealAllowanceDay * 100) / 100;
    const overtimeBonus = Math.round(overtimeHours * hourlyRate * (overtimeRatePct / 100) * 100) / 100;

    const ex = existingMap[p.id];
    const otherAdditions  = ex?.other_additions  ?? 0;
    const otherDeductions = ex?.other_deductions ?? 0;
    const notes           = ex?.notes ?? null;
    // Não sobrescrever status/paid_at se já aprovado ou pago
    const status  = ex?.status === "aprovado" || ex?.status === "pago" ? ex.status : "rascunho";
    const paidAt  = ex?.paid_at ?? null;

    const netSalary = Math.round(
      (grossSalary + mealAllowance + overtimeBonus + otherAdditions
        - absenceDeductions - otherDeductions) * 100,
    ) / 100;

    return {
      company_id:          companyId,
      collaborator_id:     p.id,
      period_year:         year,
      period_month:        month,
      contracted_hours:    contractedHours,
      worked_hours:        workedHours,
      overtime_hours:      overtimeHours,
      absence_hours:       absenceHours,
      days_worked:         daysWorked,
      hourly_rate:         hourlyRate,
      gross_salary:        grossSalary,
      meal_allowance:      mealAllowance,
      overtime_bonus:      overtimeBonus,
      absence_deductions:  absenceDeductions,
      other_additions:     otherAdditions,
      other_deductions:    otherDeductions,
      net_salary:          netSalary,
      notes,
      status,
      paid_at:             paidAt,
    };
  });

  const { error: uErr } = await admin
    .from("payroll_records")
    .upsert(upserts, { onConflict: "company_id,collaborator_id,period_year,period_month" });

  if (uErr) return { ok: false, error: uErr.message };

  revalidatePath("/dashboard/folha-pagamento");
  return getPayrollRecords(companyId, year, month);
}

// ─── Ler registos guardados ───────────────────────────────────────────────────

export async function getPayrollRecords(
  companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; records: PayrollRecord[] } | { ok: false; error: string }> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("payroll_records")
    .select("*, profiles!collaborator_id(full_name, avatar_url)")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .order("profiles(full_name)");

  if (error) return { ok: false, error: error.message };

  const records: PayrollRecord[] = (data ?? []).map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = (r as any).profiles as { full_name: string; avatar_url: string | null } | null;
    return {
      id: r.id,
      collaborator_id:    r.collaborator_id,
      full_name:          profile?.full_name ?? "—",
      avatar_url:         profile?.avatar_url ?? null,
      period_year:        r.period_year,
      period_month:       r.period_month,
      contracted_hours:   r.contracted_hours ?? 0,
      worked_hours:       r.worked_hours ?? 0,
      overtime_hours:     r.overtime_hours ?? 0,
      absence_hours:      r.absence_hours ?? 0,
      days_worked:        r.days_worked ?? 0,
      hourly_rate:        r.hourly_rate ?? 0,
      gross_salary:       r.gross_salary ?? 0,
      meal_allowance:     r.meal_allowance ?? 0,
      overtime_bonus:     r.overtime_bonus ?? 0,
      absence_deductions: r.absence_deductions ?? 0,
      other_additions:    r.other_additions ?? 0,
      other_deductions:   r.other_deductions ?? 0,
      net_salary:         r.net_salary ?? 0,
      notes:              r.notes ?? null,
      status:             r.status as PayrollRecord["status"],
      paid_at:            r.paid_at ?? null,
    };
  });

  return { ok: true, records };
}

// ─── Ajustar manualmente um registo ──────────────────────────────────────────

export async function adjustPayrollRecord(
  id: string,
  adjust: PayrollAdjust,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  // Ler registo atual para recalcular net_salary
  const { data: rec, error: rErr } = await admin
    .from("payroll_records")
    .select("gross_salary, meal_allowance, overtime_bonus, absence_deductions, other_additions, other_deductions, worked_hours, overtime_hours, absence_hours, days_worked, hourly_rate")
    .eq("id", id)
    .single();

  if (rErr || !rec) return { ok: false, error: rErr?.message ?? "Registo não encontrado." };

  const workedHours    = adjust.worked_hours      ?? rec.worked_hours       ?? 0;
  const overtimeHours  = adjust.overtime_hours    ?? rec.overtime_hours     ?? 0;
  const absenceHours   = adjust.absence_hours     ?? rec.absence_hours      ?? 0;
  const daysWorked     = adjust.days_worked       ?? rec.days_worked        ?? 0;
  const hourlyRate     = rec.hourly_rate ?? 0;

  // Recalcular valores derivados se algum campo de horas foi alterado
  const hoursChanged = adjust.worked_hours !== undefined || adjust.overtime_hours !== undefined
    || adjust.days_worked !== undefined || adjust.absence_hours !== undefined;

  const grossSalary = hoursChanged
    ? Math.round(workedHours * hourlyRate * 100) / 100
    : (rec.gross_salary ?? 0);

  // Subsídio de alimentação: proporcional ao número de dias (usando taxa por dia do registo)
  const mealPerDay = rec.days_worked > 0
    ? (rec.meal_allowance ?? 0) / rec.days_worked
    : 0;
  const mealAllowance = hoursChanged && adjust.days_worked !== undefined
    ? Math.round(daysWorked * mealPerDay * 100) / 100
    : (rec.meal_allowance ?? 0);

  // Bónus horas extra: taxa de 25% sobre o valor/hora
  const overtimeBonus = adjust.overtime_hours !== undefined
    ? Math.round(overtimeHours * hourlyRate * 0.25 * 100) / 100
    : (rec.overtime_bonus ?? 0);

  const absenceDed = adjust.absence_deductions ?? rec.absence_deductions ?? 0;
  const otherAdd   = adjust.other_additions    ?? rec.other_additions    ?? 0;
  const otherDed   = adjust.other_deductions   ?? rec.other_deductions   ?? 0;

  const netSalary = Math.round(
    (grossSalary + mealAllowance + overtimeBonus + otherAdd - absenceDed - otherDed) * 100,
  ) / 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await admin
    .from("payroll_records")
    .update({
      worked_hours:        workedHours,
      overtime_hours:      overtimeHours,
      absence_hours:       absenceHours,
      days_worked:         daysWorked,
      gross_salary:        grossSalary,
      meal_allowance:      mealAllowance,
      overtime_bonus:      overtimeBonus,
      absence_deductions:  absenceDed,
      other_additions:     otherAdd,
      other_deductions:    otherDed,
      net_salary:          netSalary,
      notes:               adjust.notes !== undefined ? adjust.notes : undefined,
    } as any)
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/folha-pagamento");
  return { ok: true };
}

// ─── Aprovar registos ────────────────────────────────────────────────────────

export async function approvePayrollRecords(
  ids: string[],
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { error } = await admin
    .from("payroll_records")
    .update({ status: "aprovado", approved_by: user.id })
    .in("id", ids);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/folha-pagamento");
  return { ok: true };
}

// ─── Marcar como pago ────────────────────────────────────────────────────────

export async function markPayrollPaid(
  ids: string[],
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  // Buscar dados antes de marcar como pago (para o fluxo de caixa)
  const { data: records } = await admin
    .from("payroll_records")
    .select("id, company_id, collaborator_id, net_salary, period_year, period_month, profiles(full_name)")
    .in("id", ids);

  const { error } = await admin
    .from("payroll_records")
    .update({ status: "pago", paid_at: new Date().toISOString() })
    .in("id", ids);

  if (error) return { ok: false, error: error.message };

  // Auto-registo no fluxo de caixa
  if (records && records.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    const cashEntries = records.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = (r as any).profiles?.full_name ?? "Colaborador";
      return {
        company_id: r.company_id,
        type: "saida" as const,
        amount: r.net_salary,
        description: `Salário ${name} — ${r.period_month}/${r.period_year}`,
        category: "salario" as const,
        date: today,
        reference_id: r.id,
        reference_type: "payroll" as const,
        status: "confirmado" as const,
      };
    });
    await admin.from("cash_flow_entries").insert(cashEntries);
  }

  revalidatePath("/dashboard/folha-pagamento");
  revalidatePath("/dashboard/financeiro");
  return { ok: true };
}
