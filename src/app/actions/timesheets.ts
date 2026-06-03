"use server";

import { createAdminClient } from "@/lib/supabase/admin";

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
