"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";

export interface ClienteInput {
  name: string;
  email?: string;
  phone?: string;
  nif?: string;
  type?: string;
  notes?: string;
  status: string;
  vat_exempt?: boolean;
  company_id: string;
}

export async function createCliente(input: ClienteInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== input.company_id) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { error } = await admin.from("clients").insert({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    type: input.type || "empresa",
    notes: input.notes || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
    company_id: profile.company_id,
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

export interface ClienteComLocalInput {
  // Cliente
  name: string;
  type: "individual" | "empresa";
  phone?: string;
  email?: string;
  nif?: string;
  // Local
  locationName: string;
  address: string;
  hourlyRate: number | null;
  serviceType: string;
  lat?: number | null;
  lng?: number | null;
}

/** Cria cliente + local de uma vez. Devolve os dois ids. */
export async function createClienteComLocal(companyId: string, input: ClienteComLocalInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado.", clientId: null, locationId: null };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== companyId) {
    return { ok: false as const, error: "Sem permissão.", clientId: null, locationId: null };
  }

  const { data: client, error: ce } = await admin
    .from("clients")
    .insert({
      name: input.name.trim(),
      type: input.type,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      nif: input.nif?.trim() || null,
      status: "ativo",
      company_id: companyId,
    })
    .select("id")
    .single();
  if (ce || !client) return { ok: false as const, error: ce?.message ?? "Erro ao criar cliente.", clientId: null, locationId: null };

  const { data: location, error: le } = await admin
    .from("locations")
    .insert({
      name: input.locationName.trim(),
      address: input.address.trim(),
      hourly_rate: input.hourlyRate,
      service_type: input.serviceType || "limpeza_regular",
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      active: true,
      client_id: client.id,
      company_id: companyId,
    })
    .select("id")
    .single();
  if (le || !location) {
    // rollback manual do cliente criado
    await admin.from("clients").delete().eq("id", client.id);
    return { ok: false as const, error: le?.message ?? "Erro ao criar local.", clientId: null, locationId: null };
  }

  revalidatePath("/dashboard/clientes");
  revalidatePath("/dashboard/locais");
  return { ok: true as const, clientId: client.id as string, locationId: location.id as string };
}

/**
 * Arquiva (soft-delete) um cliente.
 * Bloqueia se houver serviços futuros associados ao cliente ou aos seus locais.
 */
export async function archiveCliente(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  // Verificar se existem serviços futuros ligados aos locais deste cliente
  const now = new Date().toISOString();
  const { data: locations } = await admin
    .from("locations")
    .select("id")
    .eq("client_id", id)
    .eq("company_id", profile.company_id);

  const locationIds = (locations ?? []).map((l) => l.id);
  let futureCount = 0;

  if (locationIds.length > 0) {
    const { count } = await admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .in("location_id", locationIds)
      .gt("scheduled_start", now)
      .not("status", "in", '("cancelado","concluido")');
    futureCount = count ?? 0;
  }

  if (futureCount > 0) {
    return {
      ok: false as const,
      error: `Não é possível arquivar: este cliente tem ${futureCount} serviço(s) futuros agendados. Cancele-os primeiro.`,
    };
  }

  const { error } = await admin
    .from("clients")
    .update({ status: "inativo" })
    .eq("id", id)
    .eq("company_id", profile.company_id);

  if (error) return { ok: false as const, error: error.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "client_archived",
    entityType: "client",
    entityId: id,
    after: { status: "inativo" },
    source: "dashboard",
  }, admin);

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

export async function updateCliente(id: string, input: Omit<ClienteInput, "company_id">) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { error } = await admin.from("clients").update({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    type: input.type || "empresa",
    notes: input.notes || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
  }).eq("id", id).eq("company_id", profile.company_id);

  if (error) return { ok: false as const, error: error.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "client_updated",
    entityType: "client",
    entityId: id,
    after: { name: input.name, status: input.status, nif: input.nif || null },
    source: "dashboard",
  }, admin);

  revalidatePath("/dashboard/clientes");
  revalidatePath(`/dashboard/clientes/${id}`);
  return { ok: true as const };
}

export async function deleteCliente(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { data: client } = await admin
    .from("clients")
    .select("id, name")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();
  if (!client) return { ok: false as const, error: "Cliente invalido." };

  // Locais do cliente (services/contracts têm FK RESTRICT para locations).
  const { data: locations } = await admin
    .from("locations")
    .select("id")
    .eq("client_id", id)
    .eq("company_id", profile.company_id);
  const locationIds = (locations ?? []).map((l) => l.id);

  // 1) Serviços (cascade: timesheets, fotos, reforços, auditoria de preço).
  if (locationIds.length > 0) {
    await admin.from("services").delete()
      .eq("company_id", profile.company_id).in("location_id", locationIds);
    // 2) Contratos desses locais.
    await admin.from("contracts").delete()
      .eq("company_id", profile.company_id).in("location_id", locationIds);
  }

  // 3) Faturas do cliente (invoice_items fazem cascade do invoice).
  await admin.from("invoices").delete()
    .eq("company_id", profile.company_id).eq("client_id", id);

  // 4) Cliente → cascade de locais + notificações do cliente.
  const { error } = await admin.from("clients").delete()
    .eq("id", id).eq("company_id", profile.company_id);
  if (error) return { ok: false as const, error: error.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "client_deleted",
    entityType: "client",
    entityId: id,
    before: { name: client.name },
    source: "dashboard",
  }, admin);

  revalidatePath("/dashboard/clientes");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}
