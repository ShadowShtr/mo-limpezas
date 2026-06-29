"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";
import { maxReferenceNumber } from "@/lib/services/reference";

type ActionResult = { ok: true } | { ok: false; error: string };

async function requireManager() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  return { ok: true as const, admin, userId: user.id, companyId: profile.company_id };
}

function revalidateClient(clientId?: string | null) {
  revalidatePath("/dashboard/clientes");
  if (clientId) revalidatePath(`/dashboard/clientes/${clientId}`);
  revalidatePath("/dashboard/contratos");
  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard");
}

export async function setContractInterventionStatus(
  contractId: string,
  status: "ativo" | "pausado" | "cancelado",
): Promise<ActionResult> {
  const auth = await requireManager();
  if (!auth.ok) return { ok: false, error: auth.error };

  const { admin, companyId, userId } = auth;
  const { data: contract } = await admin
    .from("contracts")
    .select("id, status, locations(client_id)")
    .eq("id", contractId)
    .eq("company_id", companyId)
    .single();

  if (!contract) return { ok: false, error: "Intervencao invalida." };

  const { error } = await admin
    .from("contracts")
    .update({ status })
    .eq("id", contractId)
    .eq("company_id", companyId);

  if (error) return { ok: false, error: error.message };

  const clientId = (contract.locations as { client_id?: string | null } | null)?.client_id ?? null;
  await auditLog({
    companyId,
    actorId: userId,
    action: "intervention.contract_status_changed",
    entityType: "contract",
    entityId: contractId,
    meta: { from: contract.status, to: status },
  }, admin);
  revalidateClient(clientId);
  return { ok: true };
}

export async function duplicatePointService(serviceId: string): Promise<ActionResult> {
  const auth = await requireManager();
  if (!auth.ok) return { ok: false, error: auth.error };

  const { admin, companyId, userId } = auth;
  const { data: service } = await admin
    .from("services")
    .select("location_id, team_id, scheduled_start, scheduled_end, hourly_rate, calculated_value, manual_value, notes")
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .single();

  if (!service) return { ok: false, error: "Servico invalido." };

  const { data: location } = await admin
    .from("locations")
    .select("client_id")
    .eq("id", service.location_id)
    .eq("company_id", companyId)
    .single();

  const originalStart = new Date(service.scheduled_start);
  const originalEnd = new Date(service.scheduled_end);
  originalStart.setDate(originalStart.getDate() + 7);
  originalEnd.setDate(originalEnd.getDate() + 7);

  // Referência baseada no MÁXIMO existente (não count(*), que colide com buracos
  // deixados por serviços apagados). Retenta em caso de corrida de unicidade.
  const baseRef = await maxReferenceNumber(admin, companyId);
  let inserted = false;
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const { error } = await admin.from("services").insert({
      company_id: companyId,
      location_id: service.location_id,
      team_id: service.team_id,
      reference_number: String(baseRef + 1 + attempt).padStart(4, "0"),
      scheduled_start: originalStart.toISOString(),
      scheduled_end: originalEnd.toISOString(),
      hourly_rate: service.hourly_rate,
      calculated_value: service.calculated_value,
      manual_value: service.manual_value,
      notes: service.notes,
      status: "agendado",
      created_by: userId,
    });
    if (!error) { inserted = true; break; }
    if (error.code !== "23505") return { ok: false, error: error.message };
    lastErr = error.message;
  }
  if (!inserted) return { ok: false, error: lastErr || "Não foi possível gerar um número de referência único." };

  await auditLog({
    companyId,
    actorId: userId,
    action: "intervention.point_service_duplicated",
    entityType: "service",
    entityId: serviceId,
    meta: { plus_days: 7 },
  }, admin);
  revalidateClient(location?.client_id ?? null);
  return { ok: true };
}
