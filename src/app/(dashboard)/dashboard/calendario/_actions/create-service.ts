"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ensureLisbonOffset } from "@/lib/lisbon-time";
import type { ConflictInfo } from "./reschedule";

export interface CreateServiceInput {
  companyId: string;
  locationId: string;
  teamId: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  hourlyRate: number | null;
  calculatedValue: number | null;
  numPeople?: number | null;
  notes: string | null;
  cleaningType?: string | null;
  paymentStatus?: string | null;
  upholsteryType?: string | null;
  upholsteryNotes?: string | null;
  upholsteryUnits?: number | null;
  upholsteryUnitPrice?: number | null;
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

  // Normaliza para o fuso de Lisboa (o cliente envia hora "naive" sem offset).
  const scheduledStart = ensureLisbonOffset(input.scheduledStart);
  const scheduledEnd = ensureLisbonOffset(input.scheduledEnd);

  if (input.teamId && !input.force) {
    const conflicts = await getConflicts(
      admin, profile.company_id, null,
      scheduledStart, scheduledEnd, input.teamId,
    );
    if (conflicts.length > 0) {
      return { ok: false, error: "A equipa tem conflito neste horário.", conflicts, canForce: true };
    }
  }

  // Gerar reference_number server-side para evitar race condition.
  // Retenta até 5 vezes em caso de conflito de unicidade (migrations/031).
  let data: { id: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { count } = await admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("company_id", profile.company_id);
    const ref = String((count ?? 0) + 1 + attempt).padStart(4, "0");

    const res = await admin
      .from("services")
      .insert({
        company_id: profile.company_id,
        location_id: input.locationId,
        team_id: input.teamId ?? null,
        reference_number: ref,
        scheduled_start: scheduledStart,
        scheduled_end: scheduledEnd,
        status: "agendado",
        hourly_rate: input.hourlyRate,
        calculated_value: input.calculatedValue,
        num_people: input.numPeople != null && input.numPeople >= 1 ? Math.floor(input.numPeople) : 1,
        notes: input.notes,
        cleaning_type: input.cleaningType ?? null,
        payment_status: input.paymentStatus ?? null,
        upholstery_type: input.upholsteryType ?? null,
        upholstery_notes: input.upholsteryNotes ?? null,
        upholstery_units: input.upholsteryUnits ?? null,
        upholstery_unit_price: input.upholsteryUnitPrice ?? null,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (!res.error) { data = res.data; break; }
    // Código 23505 = unique_violation (reference_number duplicado) → retenta
    if (!res.error.code || res.error.code !== "23505") {
      return { ok: false, error: res.error.message };
    }
  }

  if (!data) return { ok: false, error: "Não foi possível gerar um número de referência único." };

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
