"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ConflictInfo } from "./reschedule";

export interface CreateServiceInput {
  companyId: string;
  locationId: string;
  teamId: string | null;
  referenceNumber: string;
  scheduledStart: string;
  scheduledEnd: string;
  hourlyRate: number | null;
  calculatedValue: number | null;
  notes: string | null;
  force?: boolean;
}

export type CreateServiceResult =
  | { ok: true; id: string }
  | { ok: false; error: string; conflicts?: ConflictInfo[]; canForce?: boolean };

export async function createService(
  input: CreateServiceInput,
): Promise<CreateServiceResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissao." };
  }

  const { data: location } = await admin
    .from("locations")
    .select("id")
    .eq("id", input.locationId)
    .eq("company_id", profile.company_id)
    .single();
  if (!location) return { ok: false, error: "Local invalido." };

  if (input.teamId && !input.force) {
    const conflicts = await getConflicts(
      admin, profile.company_id, null,
      input.scheduledStart, input.scheduledEnd, input.teamId,
    );
    if (conflicts.length > 0) {
      return { ok: false, error: "A equipa tem conflito neste horário.", conflicts, canForce: true };
    }
  }

  const { data, error } = await admin
    .from("services")
    .insert({
      company_id: profile.company_id,
      location_id: input.locationId,
      team_id: input.teamId ?? null,
      reference_number: input.referenceNumber,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      status: "agendado",
      hourly_rate: input.hourlyRate,
      calculated_value: input.calculatedValue,
      notes: input.notes,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao criar serviço" };

  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard/mapa");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/clientes");

  return { ok: true, id: data.id };
}

async function getConflicts(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  excludeId: string | null,
  newStart: string,
  newEnd: string,
  teamId: string,
): Promise<ConflictInfo[]> {
  const dayStr = newStart.slice(0, 10);
  let q = admin
    .from("services_full")
    .select("id, reference_number, location_name, scheduled_start, scheduled_end")
    .eq("company_id", companyId)
    .eq("team_id", teamId)
    .gte("scheduled_start", `${dayStr}T00:00:00`)
    .lte("scheduled_start", `${dayStr}T23:59:59`)
    .in("status", ["agendado", "em_curso"]);

  if (excludeId) q = q.neq("id", excludeId);

  const { data: others } = await q;

  const ts = new Date(newStart).getTime();
  const te = new Date(newEnd).getTime();
  const conflicts: ConflictInfo[] = [];

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
