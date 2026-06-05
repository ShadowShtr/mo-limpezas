"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface InvoiceItem {
  id: string;
  service_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  sort_order: number;
}

export interface Invoice {
  id: string;
  client_id: string;
  client_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  status: "rascunho" | "pendente" | "pago" | "vencido" | "cancelado";
  paid_at: string | null;
  notes: string | null;
  items: InvoiceItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end   = new Date(year, month, 0).toISOString().split("T")[0];
  return { start, end };
}

async function nextInvoiceNumber(companyId: string, prefix: string, year: number): Promise<string> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .like("invoice_number", `${prefix}${year}/%`);
  const seq = (count ?? 0) + 1;
  return `${prefix}${year}/${String(seq).padStart(3, "0")}`;
}

// ─── Gerar documentos de cobrança ─────────────────────────────────────────────

export async function generateInvoices(
  companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; invoices: Invoice[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { start, end } = monthRange(year, month);

  // Configurações
  const { data: settings } = await admin
    .from("company_settings")
    .select("vat_rate, invoice_prefix")
    .eq("company_id", companyId)
    .single();

  const vatRate     = settings?.vat_rate    ?? 23;
  const prefix      = settings?.invoice_prefix ?? "F";
  const vatFactor   = vatRate / 100;

  // Serviços concluídos no período
  const { data: services, error: sErr } = await admin
    .from("services")
    .select("id, location_id, calculated_value, manual_value, scheduled_start, actual_start, actual_end")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", `${start}T00:00:00`)
    .lte("scheduled_start", `${end}T23:59:59`);

  if (sErr) return { ok: false, error: sErr.message };
  if (!services?.length) return { ok: true, invoices: [] };

  // Locais e clientes
  const locationIds = [...new Set(services.map((s) => s.location_id).filter(Boolean))];
  const { data: locations } = await admin
    .from("locations")
    .select("id, name, client_id, hourly_rate")
    .in("id", locationIds);

  const locationMap = Object.fromEntries(
    (locations ?? []).map((l) => [l.id, l]),
  );

  const clientIds = [...new Set((locations ?? []).map((l) => l.client_id).filter(Boolean))];
  const { data: clients } = await admin
    .from("clients")
    .select("id, name, nif, contact_email")
    .in("id", clientIds);

  const clientMap = Object.fromEntries(
    (clients ?? []).map((c) => [c.id, c]),
  );

  // Verificar faturas já existentes para este período (não duplicar)
  const { data: existing } = await admin
    .from("invoices")
    .select("id, client_id")
    .eq("company_id", companyId)
    .eq("period_start", start)
    .eq("period_end", end);

  const existingClientIds = new Set((existing ?? []).map((e) => e.client_id));

  // Agrupar serviços por cliente
  const byClient = new Map<string, typeof services>();
  for (const s of services) {
    const loc = locationMap[s.location_id];
    if (!loc?.client_id) continue;
    if (existingClientIds.has(loc.client_id)) continue; // já tem fatura
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    byClient.get(loc.client_id)!.push(s);
  }

  if (!byClient.size) return getInvoices(companyId, year, month);

  // Criar fatura por cliente
  const invoiceDate = new Date().toISOString().split("T")[0];
  const dueDate     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  for (const [clientId, svcs] of byClient) {
    const invoiceNumber = await nextInvoiceNumber(companyId, prefix, year);

    const items = svcs
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      .map((s, idx) => {
        const loc   = locationMap[s.location_id];
        const value = s.manual_value ?? s.calculated_value ?? 0;
        const date  = new Date(s.scheduled_start).toLocaleDateString("pt-PT");
        let durationMin = 0;
        if (s.actual_start && s.actual_end) {
          durationMin = Math.round(
            (new Date(s.actual_end).getTime() - new Date(s.actual_start).getTime()) / 60000,
          );
        }
        const durLabel = durationMin > 0
          ? ` (${Math.floor(durationMin / 60)}h${durationMin % 60 > 0 ? String(durationMin % 60).padStart(2, "0") : ""})`
          : "";
        return {
          service_id:  s.id,
          description: `${date} — ${loc?.name ?? "Serviço"}${durLabel}`,
          quantity:    1,
          unit_price:  value,
          total:       value,
          sort_order:  idx,
        };
      });

    const subtotal  = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
    const vatAmount = Math.round(subtotal * vatFactor * 100) / 100;
    const total     = Math.round((subtotal + vatAmount) * 100) / 100;

    const { data: inv, error: invErr } = await admin
      .from("invoices")
      .insert({
        company_id:     companyId,
        client_id:      clientId,
        invoice_number: invoiceNumber,
        invoice_date:   invoiceDate,
        due_date:       dueDate,
        period_start:   start,
        period_end:     end,
        subtotal,
        vat_rate:       vatRate,
        vat_amount:     vatAmount,
        total,
        status:         "rascunho",
      })
      .select("id")
      .single();

    if (invErr || !inv) continue;

    await admin
      .from("invoice_items")
      .insert(items.map((it) => ({ ...it, invoice_id: inv.id })));
  }

  revalidatePath("/dashboard/cobrancas");
  return getInvoices(companyId, year, month);
}

// ─── Ler faturas ──────────────────────────────────────────────────────────────

export async function getInvoices(
  companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; invoices: Invoice[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { start, end } = monthRange(year, month);

  const { data, error } = await admin
    .from("invoices")
    .select(`
      id, client_id, invoice_number, invoice_date, due_date,
      period_start, period_end, subtotal, vat_rate, vat_amount, total,
      status, paid_at, notes,
      clients ( name ),
      invoice_items ( id, service_id, description, quantity, unit_price, total, sort_order )
    `)
    .eq("company_id", companyId)
    .eq("period_start", start)
    .eq("period_end", end)
    .order("invoice_number");

  if (error) return { ok: false, error: error.message };

  const invoices: Invoice[] = (data ?? []).map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (row as any).clients as { name: string } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems = (row as any).invoice_items as InvoiceItem[] ?? [];
    return {
      id:             row.id,
      client_id:      row.client_id,
      client_name:    c?.name ?? "—",
      invoice_number: row.invoice_number,
      invoice_date:   row.invoice_date,
      due_date:       row.due_date ?? null,
      period_start:   row.period_start ?? null,
      period_end:     row.period_end ?? null,
      subtotal:       row.subtotal,
      vat_rate:       row.vat_rate,
      vat_amount:     row.vat_amount,
      total:          row.total,
      status:         row.status as Invoice["status"],
      paid_at:        row.paid_at ?? null,
      notes:          row.notes ?? null,
      items:          [...rawItems].sort((a, b) => a.sort_order - b.sort_order),
    };
  });

  return { ok: true, invoices };
}

// ─── Atualizar estado ─────────────────────────────────────────────────────────

export async function updateInvoiceStatus(
  id: string,
  status: Invoice["status"],
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const update: { status: string; paid_at?: string } = { status };
  if (status === "pago") update.paid_at = new Date().toISOString();

  const { error } = await admin
    .from("invoices")
    .update(update)
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/cobrancas");
  return { ok: true };
}

// ─── Eliminar rascunho ────────────────────────────────────────────────────────

export async function deleteInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { error } = await admin
    .from("invoices")
    .delete()
    .eq("id", id)
    .eq("status", "rascunho"); // só eliminar rascunhos

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/cobrancas");
  return { ok: true };
}
