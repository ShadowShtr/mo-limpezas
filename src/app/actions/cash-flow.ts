"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth-guard";
import { isValidCashFlowAmount } from "@/lib/cash-flow-integrity";
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
  _companyId: string,
  filters: CashFlowFilters,
): Promise<{ ok: true; entries: CashFlowEntry[]; balance: number; entradas: number; saidas: number; pendentes: number } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;
  const start = `${filters.year}-${String(filters.month).padStart(2, "0")}-01`;
  // getDate() lê o dia em hora local (sem round-trip por toISOString/UTC, que
  // desloca o resultado 1 dia para trás em hora de verão de Lisboa).
  const monthEndDay = new Date(filters.year, filters.month, 0).getDate();
  const end = `${filters.year}-${String(filters.month).padStart(2, "0")}-${String(monthEndDay).padStart(2, "0")}`;

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
  if (!user) return { ok: false, error: "NÃ£o autenticado." };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== companyId) {
    return { ok: false, error: "Sem permissÃ£o." };
  }
  if (!isValidCashFlowAmount(data.amount) || !data.description.trim()) {
    return { ok: false, error: "Dados invÃ¡lidos." };
  }

  const { error } = await admin.from("cash_flow_entries").insert({
    company_id: profile.company_id,
    ...data,
    created_by: user.id,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
  return { ok: true };
}

export async function updateCashFlowEntry(
  id: string,
  data: { status?: CashFlowStatus; description?: string; amount?: number; notes?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  if (data.amount !== undefined && !isValidCashFlowAmount(data.amount)) {
    return { ok: false, error: "Valor invalido." };
  }
  if (data.description !== undefined && !data.description.trim()) {
    return { ok: false, error: "Descricao invalida." };
  }

  const { error } = await admin
    .from("cash_flow_entries")
    .update(data)
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
  return { ok: true };
}

export async function deleteCashFlowEntry(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  // Só apagar entradas manuais (sem reference_type)
  const { error } = await admin
    .from("cash_flow_entries")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .is("reference_type", null);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
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

/**
 * Contas a receber e a pagar, **do período pedido**.
 *
 * 🔴 Recebia só `_companyId` e devolvia tudo, de todos os meses. O seletor
 *    dizia «Agosto 2026» e a página respondia sobre a história inteira — o
 *    mesmo defeito que `getFinancialDashboard` tinha, no outro separador.
 *
 * Cada bloco filtra pelo que faz sentido para si, e não por uma data só:
 *
 *   faturas   `period_start` — o **período contabilístico**, o mesmo critério
 *             que o dashboard usa. Filtrar por `due_date` faria uma fatura de
 *             Julho que vence a 5 de Agosto aparecer em Agosto aqui e em Julho
 *             no Resumo, e as duas áreas discordariam sobre o mesmo documento;
 *   salários  `period_year`/`period_month` — a folha é de um mês, não de um dia;
 *   despesas  `date` do movimento.
 *
 * Sem período (`undefined`), devolve tudo — o comportamento antigo, para quem
 * ainda o chame assim.
 */
export async function getAccountsData(input?: { year: number; month: number }): Promise<{
  ok: true;
  toReceive: { id: string; invoice_number: string; client_name: string; total: number; due_date: string | null; status: string }[];
  toPay: { id: string; collaborator_name: string; net_salary: number; period: string; status: string }[];
  expenses: PendingExpense[];
} | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const periodo = input
    ? {
        inicio: `${input.year}-${String(input.month).padStart(2, "0")}-01`,
        fim: `${input.year}-${String(input.month).padStart(2, "0")}-${String(
          new Date(Date.UTC(input.year, input.month, 0)).getUTCDate(),
        ).padStart(2, "0")}`,
      }
    : null;

  let invoicesQ = admin
    .from("invoices")
    .select("id, invoice_number, client_id, total, due_date, status, clients(name)")
    .eq("company_id", companyId)
    .in("status", ["pendente", "vencido"]);
  // 🔴 `period_start`, não `due_date` — o mesmo critério do motor do dashboard.
  if (periodo) invoicesQ = invoicesQ.gte("period_start", periodo.inicio).lte("period_start", periodo.fim);

  let payrollQ = admin
    .from("payroll_records")
    .select("id, collaborator_id, net_salary, period_year, period_month, status, profiles!collaborator_id(full_name)")
    .eq("company_id", companyId)
    .eq("status", "aprovado");
  if (input) payrollQ = payrollQ.eq("period_year", input.year).eq("period_month", input.month);

  let expensesQ = admin
    .from("cash_flow_entries")
    .select("id, description, amount, category, date, notes")
    .eq("company_id", companyId)
    .eq("type", "saida")
    .eq("status", "pendente")
    .is("reference_type", null);
  if (periodo) expensesQ = expensesQ.gte("date", periodo.inicio).lte("date", periodo.fim);

  const [invoicesRes, payrollRes, expensesRes] = await Promise.all([
    invoicesQ.order("due_date", { ascending: true }),
    payrollQ.order("period_year", { ascending: false }).order("period_month", { ascending: false }),
    expensesQ.order("date", { ascending: true }),
  ]);

  if (invoicesRes.error) return { ok: false, error: invoicesRes.error.message };
  if (payrollRes.error)  return { ok: false, error: payrollRes.error.message };
  // 🔴 Faltava. Uma falha a carregar despesas devolvia lista vazia e o cartão
  //    "A Pagar (Despesas)" mostrava 0,00 € — indistinguível de um mês sem
  //    despesas nenhumas.
  if (expensesRes.error) return { ok: false, error: expensesRes.error.message };

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
