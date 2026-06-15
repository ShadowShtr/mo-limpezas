"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { calcTimesheetDuration } from "@/lib/payroll-calc";
import { revalidatePath } from "next/cache";

export interface ServiceTimeUpdate {
  id: string;
  actual_start: string | null;
  actual_end: string | null;
}

export async function saveActualTimes(updates: ServiceTimeUpdate[]) {
  if (updates.length === 0) return { ok: true };

  const supabase = createAdminClient();

  const results = await Promise.all(
    updates.map((u) =>
      supabase
        .from("services")
        .update({
          actual_start: u.actual_start || null,
          actual_end: u.actual_end || null,
          status:
            u.actual_start && u.actual_end
              ? "concluido"
              : u.actual_start
              ? "em_curso"
              : undefined,
        })
        .eq("id", u.id),
    ),
  );

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    return { ok: false as const, error: "Erro ao guardar algumas entradas." };
  }
  return { ok: true as const };
}

export async function adminEditTimesheet(
  timesheetId: string,
  data: {
    clock_in_at: string | null;
    clock_out_at: string | null;
    notes?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  let duration_minutes: number | null = null;
  if (data.clock_in_at && data.clock_out_at) {
    const dur = calcTimesheetDuration(data.clock_in_at, data.clock_out_at);
    if (dur === null) {
      return { ok: false, error: "A hora de saída não pode ser anterior à de entrada." };
    }
    duration_minutes = dur;
  }

  const { error } = await admin
    .from("timesheets")
    .update({
      clock_in_at: data.clock_in_at,
      clock_out_at: data.clock_out_at,
      duration_minutes,
      notes: data.notes ?? null,
    })
    .eq("id", timesheetId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/colaboradores");
  return { ok: true };
}
