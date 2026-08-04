"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import { assertCriticalFieldsLoaded, CRITICAL_FIELDS_BLOCKED_MESSAGE } from "@/lib/critical-fields";

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

type ClientMutationErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN_ACTOR"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "MUTATION_REUSE_CONFLICT"
  | "INTERNAL_ERROR";

type ArchiveClientResult =
  | { ok: true; code: "OK"; client_id: string; sequence: number }
  | { ok: false; code: "REVISION_CONFLICT"; current_revision: number; expected_revision: number }
  | { ok: false; code: ClientMutationErrorCode };

type DeleteEmptyClientResult =
  | { ok: true; code: "OK"; client_id: string; sequence: number }
  | {
      ok: false;
      code: "CLIENT_HAS_HISTORY";
      client_id: string;
      revision: number;
      history: {
        contracts: number;
        services: number;
        timesheets: number;
        invoices: number;
        cash_flow_entries: number;
      };
    }
  | { ok: false; code: "REVISION_CONFLICT"; current_revision: number; expected_revision: number }
  | { ok: false; code: ClientMutationErrorCode };

function mutationErrorMessage(result: Exclude<ArchiveClientResult | DeleteEmptyClientResult, { ok: true }>) {
  if (result.code === "REVISION_CONFLICT") return "Este registo foi alterado por outro utilizador. Atualize a página e tente novamente.";
  if (result.code === "CLIENT_HAS_HISTORY") return "Este cliente tem histórico (contratos, serviços, faturas ou pagamentos) e não pode ser eliminado.";
  if (result.code === "FORBIDDEN_ACTOR") return "Sem permissao.";
  if (result.code === "NOT_FOUND") return "Cliente invalido.";
  if (result.code === "MUTATION_REUSE_CONFLICT") return "Esta operação já foi usada com outros dados. Tente novamente.";
  if (result.code === "INVALID_INPUT") return "Dados inválidos.";
  return "Erro interno.";
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
 */
export async function archiveCliente(id: string, expectedRevision: number, mutationId = crypto.randomUUID()) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false as const, error: "Revisão inválida." };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { data: mutationResult, error } = await admin.rpc("archive_client_atomic", {
    p_client_id: id,
    p_company_id: profile.company_id,
    p_actor: user.id,
    p_mutation_id: mutationId,
    p_expected_revision: expectedRevision,
  });
  if (error) return { ok: false as const, error: error.message };

  const result = mutationResult;
  if (!result?.ok) return { ok: false as const, error: mutationErrorMessage(result ?? { ok: false, code: "INTERNAL_ERROR" }) };

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
  revalidatePath(`/dashboard/clientes/${id}`);
  revalidatePath("/dashboard/calendario");
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

  const criticalCheck = assertCriticalFieldsLoaded("clients", input as unknown as Record<string, unknown>, { requireAll: true });
  if (!criticalCheck.ok) {
    return { ok: false as const, error: CRITICAL_FIELDS_BLOCKED_MESSAGE };
  }

  // Valor antigo, só para a auditoria (ver comentário abaixo) — nunca bloqueia
  // o update se falhar.
  const { data: before } = await admin
    .from("clients")
    .select("type, notes")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();

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

  // Auditoria de type/notes — sem isto não há como recuperar um valor
  // apagado por engano (foi o que aconteceu ao editar um cliente pela lista,
  // que não busca estas 2 colunas — ver src/lib/cliente-sheet-fields.ts).
  const after = { type: input.type || "empresa", notes: input.notes || null };
  if (before && (before.type !== after.type || before.notes !== after.notes)) {
    await auditLog({
      companyId: profile.company_id,
      actorId: user.id,
      action: "client_type_notes_changed",
      entityType: "client",
      entityId: id,
      before,
      after,
      source: "dashboard",
    }, admin);
  }

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

export async function deleteCliente(id: string, expectedRevision: number, mutationId = crypto.randomUUID()) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false as const, error: "Revisão inválida." };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { data: mutationResult, error } = await admin.rpc("delete_empty_client_atomic", {
    p_client_id: id,
    p_company_id: profile.company_id,
    p_actor: user.id,
    p_mutation_id: mutationId,
    p_expected_revision: expectedRevision,
  });
  if (error) return { ok: false as const, error: error.message };

  const result = mutationResult;
  if (result?.code === "CLIENT_HAS_HISTORY") {
    return {
      ok: false as const,
      code: "CLIENT_HAS_HISTORY" as const,
      error: mutationErrorMessage(result),
      history: result.history,
    };
  }
  if (!result?.ok) return { ok: false as const, error: mutationErrorMessage(result ?? { ok: false, code: "INTERNAL_ERROR" }) };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "client_deleted",
    entityType: "client",
    entityId: id,
    source: "dashboard",
  }, admin);

  revalidatePath("/dashboard/clientes");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}
