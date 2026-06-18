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
    })
    .eq("id", timesheetId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/colaboradores");
  revalidatePath("/dashboard/registo-ponto");
  return { ok: true };
}

/**
 * Cria manualmente um registo de ponto para um colaborador num serviço.
 * Usado no Registo de Ponto quando não existe ainda um timesheet (ex: registo em falta).
 * timesheets.service_id é obrigatório (FK), por isso é preciso um serviço associado.
 */
export async function adminCreateTimesheet(
  serviceId: string,
  collaboratorId: string,
  data: { clock_in_at: string; clock_out_at: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  // company_id deduzido do serviço para manter o multi-tenant consistente
  const { data: svc, error: svcErr } = await admin
    .from("services")
    .select("company_id")
    .eq("id", serviceId)
    .single();
  if (svcErr || !svc) return { ok: false, error: "Serviço não encontrado." };

  let duration_minutes: number | null = null;
  if (data.clock_in_at && data.clock_out_at) {
    const dur = calcTimesheetDuration(data.clock_in_at, data.clock_out_at);
    if (dur === null) return { ok: false, error: "A hora de saída não pode ser anterior à de entrada." };
    duration_minutes = dur;
  }

  const { error } = await admin.from("timesheets").insert({
    service_id: serviceId,
    collaborator_id: collaboratorId,
    company_id: svc.company_id,
    clock_in_at: data.clock_in_at,
    clock_out_at: data.clock_out_at,
    duration_minutes,
    manual_checkin: true,
    notes: "Registo criado manualmente pelo gestor",
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/colaboradores");
  revalidatePath("/dashboard/registo-ponto");
  return { ok: true };
}
