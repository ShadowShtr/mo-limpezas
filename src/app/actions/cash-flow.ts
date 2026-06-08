"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export type CashFlowType = "entrada" | "saida";
export type CashFlowCategory = "faturacao" | "salario" | "despesa" | "fornecedor" | "outro";
export type CashFlowStatus = "pendente" | "confirmado";

export interface CashFlowEntry {
  id: string;
  type: CashFlowType;
  amount: number;
  description: string;
  category: CashFlowCategory | null;
  date: string;
  reference_id: string | null;
  reference_type: "invoice" | "payroll" | null;
  status: CashFlowStatus;
  notes: string | null;
  created_at: string;
}

export interface CashFlowFilters {
  year: number;
  month: number;
  type?: CashFlowType;
  status?: CashFlowStatus;
}

export async function getCashFlowEntries(
  companyId: string,
  filters: CashFlowFilters,
): Promise<{ ok: true; entries: CashFlowEntry[]; balance: number; entradas: number; saidas: number; pendentes: number } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const start = `${filters.year}-${String(filters.month).padStart(2, "0")}-01`;
  const end   = new Date(filters.year, filters.month, 0).toISOString().split("T")[0];

  let query = admin
    .from("cash_flow_entries")
    .select("*")
    .eq("company_id", companyId)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });

  if (filters.type) query = query.eq("type", filters.type);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };

  const entries = (data ?? []) as CashFlowEntry[];
  const confirmed = entries.filter((e) => e.status === "confirmado");
  const entradas  = confirmed.filter((e) => e.type === "entrada").reduce((s, e) => s + e.amount, 0);
  const saidas    = confirmed.filter((e) => e.type === "saida").reduce((s, e) => s + e.amount, 0);
  const pendentes = entries.filter((e) => e.status === "pendente").reduce((s, e) => s + e.amount, 0);
  const balance   = Math.round((entradas - saidas) * 100) / 100;

  return { ok: true, entries, balance, entradas, saidas, pendentes };
}

export async function createCashFlowEntry(
  companyId: string,
  data: {
    type: CashFlowType;
    amount: number;
    description: string;
    category: CashFlowCategory;
    date: string;
    status: CashFlowStatus;
    notes?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const admin = createAdminClient();
  const { error } = await admin.from("cash_flow_entries").insert({
    company_id: companyId,
    ...data,
    created_by: user?.id ?? null,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  return { ok: true };
}

export async function updateCashFlowEntry(
  id: string,
  data: { status?: CashFlowStatus; description?: string; amount?: number; notes?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from("cash_flow_entries").update(data).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  return { ok: true };
}

export async function deleteCashFlowEntry(id: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  // Só apagar entradas manuais (sem reference_type)
  const { error } = await admin
    .from("cash_flow_entries")
    .delete()
    .eq("id", id)
    .is("reference_type", null);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  return { ok: true };
}

export interface PendingExpense {
  id: string;
  description: string;
  amount: number;
  category: string;
  date: string;
  notes: string | null;
}

export async function getAccountsData(companyId: string): Promise<{
  ok: true;
  toReceive: { id: string; invoice_number: string; client_name: string; total: number; due_date: string | null; status: string }[];
  toPay: { id: string; collaborator_name: string; net_salary: number; period: string; status: string }[];
  expenses: PendingExpense[];
} | { ok: false; error: string }> {
  const admin = createAdminClient();

  const [invoicesRes, payrollRes, expensesRes] = await Promise.all([
    admin
      .from("invoices")
      .select("id, invoice_number, client_id, total, due_date, status, clients(name)")
      .eq("company_id", companyId)
      .in("status", ["pendente", "vencido"])
      .order("due_date", { ascending: true }),
    admin
      .from("payroll_records")
      .select("id, collaborator_id, net_salary, period_year, period_month, status, profiles!collaborator_id(full_name)")
      .eq("company_id", companyId)
      .eq("status", "aprovado")
      .order("period_year", { ascending: false })
      .order("period_month", { ascending: false }),
    admin
      .from("cash_flow_entries")
      .select("id, description, amount, category, date, notes")
      .eq("company_id", companyId)
      .eq("type", "saida")
      .eq("status", "pendente")
      .is("reference_type", null)
      .order("date", { ascending: true }),
  ]);

  if (invoicesRes.error) return { ok: false, error: invoicesRes.error.message };
  if (payrollRes.error)  return { ok: false, error: payrollRes.error.message };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toReceive = (invoicesRes.data ?? []).map((r: any) => ({
    id: r.id,
    invoice_number: r.invoice_number,
    client_name: r.clients?.name ?? "—",
    total: r.total,
    due_date: r.due_date,
    status: r.status,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toPay = (payrollRes.data ?? []).map((r: any) => ({
    id: r.id,
    collaborator_name: r.profiles?.full_name ?? "—",
    net_salary: r.net_salary,
    period: `${r.period_month}/${r.period_year}`,
    status: r.status,
  }));

  const expenses: PendingExpense[] = (expensesRes.data ?? []).map((r) => ({
    id: r.id,
    description: r.description,
    amount: r.amount,
    category: r.category ?? "outro",
    date: r.date,
    notes: r.notes ?? null,
  }));

  return { ok: true, toReceive, toPay, expenses };
}
