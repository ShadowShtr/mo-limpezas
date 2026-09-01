"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import { assertFinancialPeriodOpen } from "@/lib/finance-period-guard";

export interface RecurrencePreviewItem {
  id: string;
  seriesId: string;
  description: string;
  amount: number | null;
  intervalMonths: number;
  anchorDate: string;
  nextDueDate: string;
  status: "will_create" | "already_exists";
}

export interface LegacyUnknownRecurrence {
  id: string;
  description: string;
  amount: number | null;
  dueDate: string | null;
  periodYear: number;
  periodMonth: number;
}

export interface RecurrencePreview {
  target: { year: number; month: number };
  configured: RecurrencePreviewItem[];
  unknown: LegacyUnknownRecurrence[];
}

type PaymentRecurrenceRow = {
  id: string;
  source_id: string | null;
  description: string;
  amount: number | null;
  due_date: string | null;
  recurring: boolean;
  period_year: number;
  period_month: number;
  recurrence_interval_months: number | null;
  recurrence_anchor_date: string | null;
  recurrence_state: string;
};

function targetDate(anchor: string, year: number, month: number): string {
  const day = Number(anchor.slice(8, 10));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function monthDelta(anchor: string, year: number, month: number): number {
  const ay = Number(anchor.slice(0, 4));
  const am = Number(anchor.slice(5, 7));
  return year * 12 + month - (ay * 12 + am);
}

export async function previewRecurringPaymentsMonth(
  year: number,
  month: number,
): Promise<{ ok: true; preview: RecurrencePreview } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  if (month < 1 || month > 12 || year < 2000 || year > 2200) return { ok: false, error: "Período inválido." };

  const { admin, profile } = guard;
  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select("id, source_id, description, amount, due_date, recurring, period_year, period_month, recurrence_interval_months, recurrence_anchor_date, recurrence_state")
    .eq("company_id", profile.company_id)
    .eq("kind", "fixo")
    .eq("recurring", true)
    .order("description");
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as unknown as PaymentRecurrenceRow[];
  const existingSeries = new Set(
    rows
      .filter((row) => row.period_year === year && row.period_month === month)
      .flatMap((row) => [row.id, row.source_id].filter((id): id is string => Boolean(id))),
  );

  const unknown = rows
    .filter((row) => row.recurrence_state === "LEGACY_RECURRENCE_UNKNOWN")
    .map((row) => ({
      id: row.id,
      description: row.description,
      amount: row.amount,
      dueDate: row.due_date,
      periodYear: row.period_year,
      periodMonth: row.period_month,
    }));

  const configured: RecurrencePreviewItem[] = [];
  for (const row of rows) {
    if (row.recurrence_state !== "CONFIGURED" || !row.recurrence_anchor_date || !row.recurrence_interval_months) continue;
    const delta = monthDelta(row.recurrence_anchor_date, year, month);
    if (delta < 0 || delta % row.recurrence_interval_months !== 0) continue;
    const seriesId = row.source_id ?? row.id;
    configured.push({
      id: row.id,
      seriesId,
      description: row.description,
      amount: row.amount,
      intervalMonths: row.recurrence_interval_months,
      anchorDate: row.recurrence_anchor_date,
      nextDueDate: targetDate(row.recurrence_anchor_date, year, month),
      status: existingSeries.has(seriesId) ? "already_exists" : "will_create",
    });
  }

  configured.sort((a, b) => a.description.localeCompare(b.description, "pt-PT") || a.seriesId.localeCompare(b.seriesId));
  return { ok: true, preview: { target: { year, month }, configured, unknown } };
}

export async function configurePaymentRecurrence(input: {
  paymentId: string;
  intervalMonths: number;
  anchorDate: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths <= 0) {
    return { ok: false, error: "Periodicidade inválida." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate)) return { ok: false, error: "Data âncora inválida." };

  const { data: payment, error: readError } = await admin
    .from("fixed_variable_payments")
    .select("id, kind, recurring, period_year, period_month")
    .eq("company_id", profile.company_id)
    .eq("id", input.paymentId)
    .maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  if (!payment || payment.kind !== "fixo" || payment.recurring !== true) {
    return { ok: false, error: "Só pagamentos fixos recorrentes podem ser configurados." };
  }

  const periodDate = `${payment.period_year}-${String(payment.period_month).padStart(2, "0")}-01`;
  const open = await assertFinancialPeriodOpen({ cliente: admin, companyId: profile.company_id, data: periodDate });
  if (!open.ok) return { ok: false, error: open.error };

  const { error } = await admin
    .from("fixed_variable_payments")
    .update({
      recurrence_interval_months: input.intervalMonths,
      recurrence_anchor_date: input.anchorDate,
    } as never)
    .eq("company_id", profile.company_id)
    .eq("id", input.paymentId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/financeiro/pagamentos");
  return { ok: true };
}

export async function prepareRecurringPaymentsMonth(
  year: number,
  month: number,
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const targetDateValue = `${year}-${String(month).padStart(2, "0")}-01`;
  const open = await assertFinancialPeriodOpen({ cliente: admin, companyId: profile.company_id, data: targetDateValue });
  if (!open.ok) return { ok: false, error: open.error };

  const { data, error } = await admin.rpc("prepare_recurring_payments_month_atomic", {
    p_company_id: profile.company_id,
    p_year: year,
    p_month: month,
    p_actor: profile.id,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/financeiro/pagamentos");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard");
  return { ok: true, created: Array.isArray(data) ? data.length : 0 };
}
