"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";
import { ensureLisbonOffset } from "@/lib/lisbon-time";

export type ConflictInfo = {
  id: string;
  reference_number: string;
  location_name: string;
  scheduled_start: string;
  scheduled_end: string;
};

export type RescheduleResult =
  | { ok: true; conflicts: ConflictInfo[] }
  | { ok: false; error: string; conflicts?: ConflictInfo[]; canForce?: boolean }

export async function rescheduleService(
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
  options?: { force?: boolean; reason?: string },
): Promise<RescheduleResult> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Nao autenticado." };

  // Normaliza para o fuso de Lisboa (o cliente envia hora "naive" sem offset).
  newStart = ensureLisbonOffset(newStart);
  newEnd = ensureLisbonOffset(newEnd);

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissao." };
  }

  const { data: service } = await admin
    .from("services")
    .select("id, company_id, team_id, status, scheduled_start, scheduled_end")
    .eq("id", serviceId)
    .eq("company_id", profile.company_id)
    .single();

  if (!service) return { ok: false, error: "Servico invalido." };
  if (["concluido", "cancelado", "falta"].includes(service.status)) {
    return { ok: false, error: "Este servico ja esta fechado e nao pode ser movido por drag." };
  }
  if (service.status === "em_curso" && !options?.force) {
    return { ok: false, error: "Servico em curso. Confirme antes de mover.", canForce: true };
  }

  if (newTeamId) {
    const { data: team } = await admin
      .from("teams")
      .select("id")
      .eq("id", newTeamId)
      .eq("company_id", profile.company_id)
      .eq("active", true)
      .single();
    if (!team) return { ok: false, error: "Equipa destino invalida ou inativa." };
  }

  const conflicts = await getConflicts(admin, profile.company_id, serviceId, newStart, newEnd, newTeamId);
  if (conflicts.length > 0 && !options?.force) {
    return {
      ok: false,
      error: "A equipa destino tem conflito neste horario.",
      conflicts,
      canForce: true,
    };
  }

  const { error } = await admin
    .from("services")
    .update({ scheduled_start: newStart, scheduled_end: newEnd, team_id: newTeamId })
    .eq("id", serviceId)
    .eq("company_id", profile.company_id);

  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "service_rescheduled_drag_drop",
    entityType: "service",
    entityId: serviceId,
    before: {
      team_id: service.team_id,
      scheduled_start: service.scheduled_start,
      scheduled_end: service.scheduled_end,
    },
    after: {
      team_id: newTeamId,
      scheduled_start: newStart,
      scheduled_end: newEnd,
    },
    meta: {
      source: "calendar_drag_drop",
      forced: !!options?.force,
      reason: options?.reason ?? null,
      conflicts_ignored: conflicts.length,
    },
  }, admin);

  return { ok: true, conflicts };
}

async function getConflicts(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
): Promise<ConflictInfo[]> {
  if (!newTeamId) return [];
  const dayStr = newStart.slice(0, 10);
  const { data: others } = await admin
    .from("services_full")
    .select("id, reference_number, location_name, scheduled_start, scheduled_end")
    .eq("company_id", companyId)
    .eq("team_id", newTeamId)
    .gte("scheduled_start", `${dayStr}T00:00:00`)
    .lte("scheduled_start", `${dayStr}T23:59:59`)
    .neq("id", serviceId)
    .in("status", ["agendado", "em_curso"]);

  const conflicts: ConflictInfo[] = [];
  const ts = new Date(newStart).getTime();
  const te = new Date(newEnd).getTime();

  for (const o of others ?? []) {
    const os = new Date(o.scheduled_start).getTime();
    const oe = new Date(o.scheduled_end).getTime();
    if (!(te <= os || ts >= oe)) {
      conflicts.push({
        id: o.id,
        reference_number: o.reference_number,
        location_name: o.location_name,
        scheduled_start: o.scheduled_start,
        scheduled_end: o.scheduled_end,
      });
    }
  }

  return conflicts;
}
