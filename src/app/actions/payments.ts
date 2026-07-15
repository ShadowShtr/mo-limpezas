"use server";

import { requireProfile } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import { todayInLisbon } from "@/lib/lisbon-time";
import {
  PAYMENT_ATTACHMENTS_BUCKET,
  MAX_PAYMENT_ATTACHMENT_BYTES,
  buildPaymentAttachmentPath,
  isPaymentAttachmentPathInCompany,
} from "@/lib/payment-attachments";

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
  attachment_url: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
  attachment_mime: string | null;
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

const COLS = "id, kind, description, amount, due_date, direct_debit, status, recurring, period_year, period_month, paid_at, notes, sort_order, attachment_url, attachment_name, attachment_size, attachment_mime";

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

// ─── Anexo (fatura/recibo) ────────────────────────────────────────────────────

async function ensureAttachmentsBucket(admin: AdminClient) {
  const { error } = await admin.storage.getBucket(PAYMENT_ATTACHMENTS_BUCKET);
  if (error) {
    await admin.storage.createBucket(PAYMENT_ATTACHMENTS_BUCKET, {
      public: false,
      fileSizeLimit: MAX_PAYMENT_ATTACHMENT_BYTES,
    });
  }
}

export async function uploadPaymentAttachment(
  paymentId: string,
  formData: FormData,
): Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: payment } = await admin
    .from("fixed_variable_payments")
    .select("id, attachment_url")
    .eq("id", paymentId)
    .eq("company_id", profile.company_id)
    .single();
  if (!payment) return { ok: false, error: "Pagamento não encontrado." };

  const file = formData.get("file") as File | null;
  if (!file) return { ok: false, error: "Ficheiro em falta." };
  if (file.size > MAX_PAYMENT_ATTACHMENT_BYTES) {
    return { ok: false, error: "Ficheiro demasiado grande (máx 20 MB)." };
  }

  await ensureAttachmentsBucket(admin);

  const path = buildPaymentAttachmentPath({ companyId: profile.company_id, paymentId, fileName: file.name });
  const { error: uploadError } = await admin.storage
    .from(PAYMENT_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  // Substitui um anexo anterior — remove o ficheiro antigo do storage.
  if (payment.attachment_url) {
    const bucketPrefix = `/${PAYMENT_ATTACHMENTS_BUCKET}/`;
    const oldPath = payment.attachment_url.includes(bucketPrefix)
      ? decodeURIComponent(payment.attachment_url.split(bucketPrefix)[1])
      : null;
    if (oldPath && isPaymentAttachmentPathInCompany(oldPath, profile.company_id)) {
      await admin.storage.from(PAYMENT_ATTACHMENTS_BUCKET).remove([oldPath]);
    }
  }

  const { data: urlData } = admin.storage.from(PAYMENT_ATTACHMENTS_BUCKET).getPublicUrl(path);

  const { error: dbError } = await admin
    .from("fixed_variable_payments")
    .update({
      attachment_url: urlData.publicUrl,
      attachment_name: file.name,
      attachment_size: file.size,
      attachment_mime: file.type,
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
    .eq("company_id", profile.company_id);
  if (dbError) return { ok: false, error: dbError.message };

  revalidate();
  return { ok: true, url: urlData.publicUrl, name: file.name };
}

export async function deletePaymentAttachment(paymentId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: payment } = await admin
    .from("fixed_variable_payments")
    .select("attachment_url")
    .eq("id", paymentId)
    .eq("company_id", profile.company_id)
    .single();
  if (!payment) return { ok: false, error: "Pagamento não encontrado." };

  if (payment.attachment_url) {
    const bucketPrefix = `/${PAYMENT_ATTACHMENTS_BUCKET}/`;
    const path = payment.attachment_url.includes(bucketPrefix)
      ? decodeURIComponent(payment.attachment_url.split(bucketPrefix)[1])
      : null;
    if (path && isPaymentAttachmentPathInCompany(path, profile.company_id)) {
      await admin.storage.from(PAYMENT_ATTACHMENTS_BUCKET).remove([path]);
    }
  }

  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ attachment_url: null, attachment_name: null, attachment_size: null, attachment_mime: null, updated_at: new Date().toISOString() })
    .eq("id", paymentId)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

export async function getSignedPaymentAttachmentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!fileUrl) return { ok: false, error: "URL do ficheiro em falta." };
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const bucketPrefix = `/${PAYMENT_ATTACHMENTS_BUCKET}/`;
  const storagePath = fileUrl.includes(bucketPrefix) ? fileUrl.split(bucketPrefix)[1] : null;
  if (!storagePath) return { ok: true, url: fileUrl };

  const decodedPath = decodeURIComponent(storagePath);
  if (!isPaymentAttachmentPathInCompany(decodedPath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
  }

  const { data, error } = await admin.storage
    .from(PAYMENT_ATTACHMENTS_BUCKET)
    .createSignedUrl(decodedPath, 60 * 5);
  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link." };

  return { ok: true, url: data.signedUrl };
}
