"use server";

import { createClient } from "@/lib/supabase/server";

export type ConflictInfo = {
  id: string;
  reference_number: string;
  location_name: string;
  scheduled_start: string;
  scheduled_end: string;
};

export type RescheduleResult =
  | { ok: true; conflicts: ConflictInfo[] }
  | { ok: false; error: string };

export async function rescheduleService(
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
): Promise<RescheduleResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("services")
    .update({ scheduled_start: newStart, scheduled_end: newEnd, team_id: newTeamId })
    .eq("id", serviceId);

  if (error) return { ok: false, error: error.message };

  if (!newTeamId) return { ok: true, conflicts: [] };

  // Detetar conflitos na mesma equipa no mesmo dia
  const dayStr = newStart.slice(0, 10);
  const { data: others } = await supabase
    .from("services_full")
    .select("id, reference_number, location_name, scheduled_start, scheduled_end")
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

  return { ok: true, conflicts };
}
