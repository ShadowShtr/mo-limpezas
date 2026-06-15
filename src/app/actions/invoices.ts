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
  payment_method: string | null;
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

  // Locais e clientes (incluindo locais com preço fixo que têm contratos activos)
  const serviceLocationIds = [...new Set(services.map((s) => s.location_id).filter(Boolean))];

  // Locais com preço fixo que têm contratos activos no período
  const { data: fixedLocations } = await admin
    .from("locations")
    .select("id, name, client_id, hourly_rate, fixed_price, pricing_type")
    .eq("company_id", companyId)
    .eq("pricing_type", "fixed")
    .eq("active", true);

  // Verificar quais têm contrato activo no período
  const fixedLocationIds = (fixedLocations ?? []).map((l) => l.id);
  let activeFixedLocationIds: string[] = [];
  if (fixedLocationIds.length > 0) {
    const { data: activeContracts } = await admin
      .from("contracts")
      .select("location_id")
      .eq("company_id", companyId)
      .eq("status", "ativo")
      .lte("starts_on", end)
      .or(`ends_on.is.null,ends_on.gte.${start}`)
      .in("location_id", fixedLocationIds);
    activeFixedLocationIds = [...new Set((activeContracts ?? []).map((c) => c.location_id))];
  }

  const allLocationIds = [...new Set([...serviceLocationIds, ...activeFixedLocationIds])];
  const { data: locations } = await admin
    .from("locations")
    .select("id, name, client_id, hourly_rate, fixed_price, pricing_type")
    .in("id", allLocationIds);

  const locationMap = Object.fromEntries(
    (locations ?? []).map((l) => [l.id, l]),
  );

  const clientIds = [...new Set((locations ?? []).map((l) => l.client_id).filter(Boolean))];
  const { data: clients } = await admin
    .from("clients")
    .select("id, name, nif, email, vat_exempt")
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

  // Agrupar serviços por cliente (excluindo locais com preço fixo — tratados à parte)
  const byClient = new Map<string, typeof services>();
  for (const s of services) {
    const loc = locationMap[s.location_id];
    if (!loc?.client_id) continue;
    if (loc.pricing_type === "fixed") continue; // preço fixo: linha separada
    if (existingClientIds.has(loc.client_id)) continue; // já tem fatura
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    byClient.get(loc.client_id)!.push(s);
  }

  // Locais com preço fixo activos → adicionar ao mapa de clientes
  for (const locId of activeFixedLocationIds) {
    const loc = locationMap[locId];
    if (!loc?.client_id || !loc.fixed_price) continue;
    if (existingClientIds.has(loc.client_id)) continue;
    // Registo sintético para o preço fixo
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    // Adiciona um serviço sintético (id = locId para ser identificável)
    byClient.get(loc.client_id)!.push({
      id: `fixed:${locId}`,
      location_id: locId,
      calculated_value: loc.fixed_price,
      manual_value: null,
      scheduled_start: `${start}T00:00:00`,
      actual_start: null,
      actual_end: null,
    });
  }

  if (!byClient.size) return getInvoices(companyId, year, month);

  // Criar fatura por cliente
  const invoiceDate = new Date().toISOString().split("T")[0];
  const dueDate     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  for (const [clientId, svcs] of byClient) {
    const invoiceNumber = await nextInvoiceNumber(companyId, prefix, year);

    const clientData = clientMap[clientId];
    const isVatExempt = (clientData as { vat_exempt?: boolean })?.vat_exempt === true;
    const effectiveVatFactor = isVatExempt ? 0 : vatFactor;
    const effectiveVatRate   = isVatExempt ? 0 : vatRate;

    const items = svcs
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      .map((s, idx) => {
        const loc   = locationMap[s.location_id];
        const isFixed = (s.id as string).startsWith("fixed:");
        const value = s.manual_value ?? s.calculated_value ?? 0;

        let description: string;
        if (isFixed) {
          const mLabel = new Date(s.scheduled_start).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
          description = `${loc?.name ?? "Serviço"} — Avença mensal ${mLabel}`;
        } else {
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
          description = `${date} — ${loc?.name ?? "Serviço"}${durLabel}`;
        }

        return {
          service_id:  isFixed ? null : s.id,
          description,
          quantity:    1,
          unit_price:  value,
          total:       value,
          sort_order:  idx,
        };
      });

    const subtotal  = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
    const vatAmount = Math.round(subtotal * effectiveVatFactor * 100) / 100;
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
        vat_rate:       effectiveVatRate,
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
      status, paid_at, payment_method, notes,
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
      payment_method: row.payment_method ?? null,
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
  paymentMethod?: string,
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

  const update: { status: string; paid_at?: string; payment_method?: string | null } = { status };
  if (status === "pago") {
    update.paid_at = new Date().toISOString();
    update.payment_method = paymentMethod ?? null;
    // Auto-registo no fluxo de caixa
    const { data: inv } = await admin.from("invoices").select("company_id, total, invoice_number, client_id").eq("id", id).eq("company_id", profile.company_id).single();
    if (inv) {
      const { data: clientData } = await admin.from("clients").select("name").eq("id", inv.client_id).single();
      await admin.from("cash_flow_entries").insert({
        company_id: inv.company_id,
        type: "entrada",
        amount: inv.total,
        description: `Fatura ${inv.invoice_number} — ${(clientData as { name?: string })?.name ?? "Cliente"}`,
        category: "faturacao",
        date: new Date().toISOString().split("T")[0],
        reference_id: id,
        reference_type: "invoice",
        status: "confirmado",
      });
    }
  }

  const { error } = await admin
    .from("invoices")
    .update(update)
    .eq("id", id)
    .eq("company_id", profile.company_id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
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

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  const { error } = await admin
    .from("invoices")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .eq("status", "rascunho"); // só eliminar rascunhos

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/cobrancas");
  return { ok: true };
}

// ─── Serviços concluídos sem fatura ──────────────────────────────────────────

export interface UnbilledService {
  id: string;
  reference_number: string;
  client_name: string;
  location_name: string;
  scheduled_start: string;
  actual_end: string | null;
  value: number;
}

export async function getUnbilledServices(
  companyId: string,
): Promise<{ ok: true; services: UnbilledService[] } | { ok: false; error: string }> {
  const admin = createAdminClient();

  // Serviços concluídos dos últimos 60 dias
  const since = new Date();
  since.setDate(since.getDate() - 60);
  const sinceStr = since.toISOString().split("T")[0];

  const { data: services, error: sErr } = await admin
    .from("services")
    .select("id, reference_number, scheduled_start, actual_end, calculated_value, manual_value, locations(name, client_id, clients(name))")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", `${sinceStr}T00:00:00`)
    .order("scheduled_start", { ascending: false });

  if (sErr) return { ok: false, error: sErr.message };
  if (!services?.length) return { ok: true, services: [] };

  // IDs de serviços que já têm invoice_item
  const serviceIds = services.map((s) => s.id);
  const { data: billed } = await admin
    .from("invoice_items")
    .select("service_id")
    .in("service_id", serviceIds);

  const billedIds = new Set((billed ?? []).map((b) => b.service_id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unbilled: UnbilledService[] = (services as any[])
    .filter((s) => !billedIds.has(s.id))
    .map((s) => ({
      id:               s.id,
      reference_number: s.reference_number ?? `#${s.id.slice(0, 6)}`,
      client_name:      s.locations?.clients?.name ?? "—",
      location_name:    s.locations?.name ?? "—",
      scheduled_start:  s.scheduled_start,
      actual_end:       s.actual_end ?? null,
      value:            s.manual_value ?? s.calculated_value ?? 0,
    }));

  return { ok: true, services: unbilled };
}
