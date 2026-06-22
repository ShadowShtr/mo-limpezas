"use server";

import { calcTimesheetDuration } from "@/lib/payroll-calc";
import { requireProfile } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";

export interface ServiceTimeUpdate {
  id: string;
  actual_start: string | null;
  actual_end: string | null;
}

export async function saveActualTimes(updates: ServiceTimeUpdate[]) {
  if (updates.length === 0) return { ok: true };

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false as const, error: guard.error };
  const { admin: supabase, profile } = guard;

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
        .eq("id", u.id)
        .eq("company_id", profile.company_id),
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
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  let duration_minutes: number | null = null;
  if (data.clock_in_at && data.clock_out_at) {
    const dur = calcTimesheetDuration(data.clock_in_at, data.clock_out_at);
    if (dur === null) {
      return { ok: false, error: "A hora de saída não pode ser anterior à de entrada." };
    }
    duration_minutes = dur;
  }

  const { data: ts, error } = await admin
    .from("timesheets")
    .update({
      clock_in_at: data.clock_in_at,
      clock_out_at: data.clock_out_at,
      duration_minutes,
    })
    .eq("id", timesheetId)
    .eq("company_id", profile.company_id)
    .select("service_id")
    .single();

  if (error) return { ok: false, error: error.message };

  // Re-avaliar actual_end e status do serviço após correção manual.
  if (ts?.service_id) {
    const { data: timesheets } = await admin
      .from("timesheets")
      .select("clock_in_at, clock_out_at")
      .eq("service_id", ts.service_id)
      .eq("company_id", profile.company_id);

    if (timesheets && timesheets.length > 0) {
      const hasOpen = timesheets.some((t) => !t.clock_out_at);
      const allOut = !hasOpen;
      const latestOut = allOut
        ? timesheets.reduce((max, t) =>
            t.clock_out_at && t.clock_out_at > max ? t.clock_out_at : max, "")
        : null;

      await admin.from("services")
        .update({
          actual_end: latestOut,
          status: allOut ? "concluido" : "em_curso",
        })
        .eq("id", ts.service_id)
        .eq("company_id", profile.company_id);
    }
  }

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
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  // Serviço e colaborador têm de pertencer à empresa da sessão
  const [{ data: svc, error: svcErr }, { data: collab, error: collabErr }] = await Promise.all([
    admin.from("services")
      .select("company_id")
      .eq("id", serviceId)
      .eq("company_id", profile.company_id)
      .single(),
    admin.from("profiles")
      .select("company_id")
      .eq("id", collaboratorId)
      .eq("company_id", profile.company_id)
      .single(),
  ]);
  if (svcErr || !svc) return { ok: false, error: "Serviço não encontrado." };
  if (collabErr || !collab) return { ok: false, error: "Colaborador não encontrado nesta empresa." };

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
