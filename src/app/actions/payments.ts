"use server";

import { requireProfile } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import { todayInLisbon } from "@/lib/lisbon-time";

type AdminClient = ReturnType<typeof createAdminClient>;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type PaymentKind = "fixo" | "variavel";
export type PaymentStatus = "pago" | "pendente";

export interface Payment {
  id: string;
  kind: PaymentKind;
  description: string;
  amount: number | null;
  due_date: string | null;
  direct_debit: boolean | null;
  status: PaymentStatus;
  recurring: boolean;
  period_year: number;
  period_month: number;
  paid_at: string | null;
  notes: string | null;
  sort_order: number;
}

export interface PaymentsData {
  year: number;
  month: number;
  fixos: Payment[];
  variaveis: Payment[];
  totalPendente: number;
  totalPago: number;
  countPendente: number;
  countOverdue: number;
}

const COLS = "id, kind, description, amount, due_date, direct_debit, status, recurring, period_year, period_month, paid_at, notes, sort_order";

// Desloca uma data para o mês alvo, mantendo o dia (limitado ao último dia do mês).
function shiftDate(due: string | null, year: number, month: number): string | null {
  if (!due) return null;
  const day = Number(due.slice(8, 10)) || 1;
  const lastDay = new Date(year, month, 0).getDate();
  const d = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Garante que os pagamentos FIXOS existem no mês pedido, clonados do mês
// anterior mais recente. Os variáveis nunca se clonam.
async function ensureMonth(admin: AdminClient, companyId: string, year: number, month: number) {
  const { data: existingRecurring } = await admin
    .from("fixed_variable_payments")
    .select("id")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .eq("recurring", true)
    .limit(1);
  if (existingRecurring && existingRecurring.length > 0) return; // já gerado

  // mês anterior mais recente com fixos
  const { data: prior } = await admin
    .from("fixed_variable_payments")
    .select("period_year, period_month")
    .eq("company_id", companyId)
    .eq("recurring", true)
    .or(`period_year.lt.${year},and(period_year.eq.${year},period_month.lt.${month})`)
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .limit(1);
  if (!prior || prior.length === 0) return; // não há fixos anteriores para repetir

  const src = prior[0];
  const { data: templates } = await admin
    .from("fixed_variable_payments")
    .select("id, description, amount, due_date, direct_debit, notes, sort_order, created_by")
    .eq("company_id", companyId)
    .eq("recurring", true)
    .eq("period_year", src.period_year)
    .eq("period_month", src.period_month);
  if (!templates || templates.length === 0) return;

  const rows = templates.map((t) => ({
    company_id: companyId,
    kind: "fixo" as const,
    description: t.description,
    amount: t.amount,
    due_date: shiftDate(t.due_date, year, month),
    direct_debit: t.direct_debit,
    status: "pendente" as const,
    recurring: true,
    period_year: year,
    period_month: month,
    notes: t.notes,
    sort_order: t.sort_order,
    source_id: t.id,
    created_by: t.created_by ?? null,
  }));
  await admin.from("fixed_variable_payments").insert(rows);
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

export async function getPayments(year: number, month: number): Promise<{ ok: true; data: PaymentsData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  await ensureMonth(admin, companyId, year, month);

  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select(COLS)
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("description", { ascending: true });
  if (error) return { ok: false, error: error.message };

  const all = (data ?? []) as Payment[];
  const fixos = all.filter((p) => p.kind === "fixo");
  const variaveis = all.filter((p) => p.kind === "variavel");
  const today = todayInLisbon();
  const totalPendente = all.filter((p) => p.status === "pendente").reduce((s, p) => s + (p.amount ?? 0), 0);
  const totalPago = all.filter((p) => p.status === "pago").reduce((s, p) => s + (p.amount ?? 0), 0);
  const countPendente = all.filter((p) => p.status === "pendente").length;
  const countOverdue = all.filter((p) => p.status === "pendente" && p.due_date && p.due_date < today).length;

  return {
    ok: true,
    data: {
      year, month, fixos, variaveis,
      totalPendente: Math.round(totalPendente * 100) / 100,
      totalPago: Math.round(totalPago * 100) / 100,
      countPendente, countOverdue,
    },
  };
}

// Lembrete para o dashboard: pendentes do mês atual.
export interface PaymentsReminder {
  count: number;
  overdueCount: number;
  total: number;
  items: { id: string; description: string; amount: number | null; due_date: string | null; overdue: boolean }[];
}

export async function getPaymentsReminder(): Promise<{ ok: true; data: PaymentsReminder } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const [year, month] = todayInLisbon().split("-").map(Number);
  await ensureMonth(admin, companyId, year, month);

  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select("id, description, amount, due_date")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .eq("status", "pendente")
    .order("due_date", { ascending: true });
  if (error) return { ok: false, error: error.message };

  const today = todayInLisbon();
  const rows = data ?? [];
  const items = rows.map((r) => ({
    id: r.id, description: r.description, amount: r.amount, due_date: r.due_date,
    overdue: !!r.due_date && r.due_date < today,
  }));
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  return {
    ok: true,
    data: {
      count: items.length,
      overdueCount: items.filter((i) => i.overdue).length,
      total: Math.round(total * 100) / 100,
      items: items.slice(0, 6),
    },
  };
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

function revalidate() {
  revalidatePath("/dashboard/financeiro/pagamentos");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard");
}

export interface PaymentInput {
  kind: PaymentKind;
  description: string;
  amount: number | null;
  due_date: string | null;
  direct_debit: boolean | null;
  notes: string | null;
  year: number;
  month: number;
}

export async function createPayment(input: PaymentInput): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  if (!input.description.trim()) return { ok: false, error: "Descrição obrigatória." };
  if (input.amount !== null && (!Number.isFinite(input.amount) || input.amount < 0)) return { ok: false, error: "Valor inválido." };

  const { data: maxRow } = await admin
    .from("fixed_variable_payments")
    .select("sort_order")
    .eq("company_id", profile.company_id)
    .eq("period_year", input.year)
    .eq("period_month", input.month)
    .eq("kind", input.kind)
    .order("sort_order", { ascending: false })
    .limit(1);
  const sort_order = (maxRow?.[0]?.sort_order ?? 0) + 1;

  const { error } = await admin.from("fixed_variable_payments").insert({
    company_id: profile.company_id,
    kind: input.kind,
    description: input.description.trim(),
    amount: input.amount,
    due_date: input.due_date,
    direct_debit: input.direct_debit,
    status: "pendente",
    recurring: input.kind === "fixo",
    period_year: input.year,
    period_month: input.month,
    notes: input.notes,
    sort_order,
    created_by: profile.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function updatePayment(
  id: string,
  patch: { description?: string; amount?: number | null; due_date?: string | null; direct_debit?: boolean | null; notes?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  if (patch.description !== undefined && !patch.description.trim()) return { ok: false, error: "Descrição inválida." };
  if (patch.amount !== undefined && patch.amount !== null && (!Number.isFinite(patch.amount) || patch.amount < 0)) return { ok: false, error: "Valor inválido." };

  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function setPaymentStatus(id: string, status: PaymentStatus): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ status, paid_at: status === "pago" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function deletePayment(id: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const { error } = await admin
    .from("fixed_variable_payments")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
