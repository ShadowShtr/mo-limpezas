"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";
import { ensureLisbonOffset, addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { getTeamSize } from "@/lib/services/reference";
import { calculateServiceValue } from "@/lib/service-value";
import { isNoRowsError, logQueryFailure, queryFailure, QUERY_FAILURE_MESSAGE } from "@/lib/query-error";

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
    .eq("auth_user_id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissao." };
  }

  const { data: service, error: serviceError } = await admin
    .from("services")
    .select("id, company_id, team_id, status, scheduled_start, scheduled_end, hourly_rate, num_people, manual_value, upholstery_unit_price, contract_id")
    .eq("id", serviceId)
    .eq("company_id", profile.company_id)
    .single();

  // Prerequisite: decide QUAL serviço é movido e se pode sê-lo. Uma falha de
  // leitura devolvia "Servico invalido." — uma afirmação sobre o serviço,
  // feita a partir de uma avaria.
  if (serviceError && !isNoRowsError(serviceError)) {
    return queryFailure("rescheduleService:service", serviceError);
  }
  if (!service) return { ok: false, error: "Servico invalido." };
  if (["concluido", "cancelado", "falta"].includes(service.status)) {
    return { ok: false, error: "Este servico ja esta fechado e nao pode ser movido por drag." };
  }
  if (service.status === "em_curso" && !options?.force) {
    return { ok: false, error: "Servico em curso. Confirme antes de mover.", canForce: true };
  }

  if (newTeamId) {
    const { data: team, error: teamError } = await admin
      .from("teams")
      .select("id")
      .eq("id", newTeamId)
      .eq("company_id", profile.company_id)
      .eq("active", true)
      .single();
    if (teamError && !isNoRowsError(teamError)) {
      return queryFailure("rescheduleService:team", teamError);
    }
    if (!team) return { ok: false, error: "Equipa destino invalida ou inativa." };
  }

  const conflicts = await getConflicts(admin, profile.company_id, serviceId, newStart, newEnd, newTeamId);
  // `null` = não se conseguiu apurar. Não é o mesmo que "não há conflitos", e
  // `--force` não o cobre: forçar é decidir apesar de um conflito conhecido,
  // não avançar às cegas.
  if (conflicts === null) {
    return { ok: false, error: QUERY_FAILURE_MESSAGE };
  }
  if (conflicts.length > 0 && !options?.force) {
    return {
      ok: false,
      error: "A equipa destino tem conflito neste horario.",
      conflicts,
      canForce: true,
    };
  }

  // Recalcula o valor pela nova duração/equipa (só serviços faturados por hora).
  // Valor manual, estofos por unidade e avença/valor fixo (hourly_rate null) ficam intactos.
  const update: {
    scheduled_start: string; scheduled_end: string; team_id: string | null;
    calculated_value?: number; num_people?: number; is_exception?: boolean;
  } = { scheduled_start: newStart, scheduled_end: newEnd, team_id: newTeamId };

  // Serviço de contrato movido à mão = exceção: a reescrita automática
  // (updateFutureServiceValuesForContract) nunca mais o pode reverter.
  if (service.contract_id != null) update.is_exception = true;

  const durationMin = (new Date(newEnd).getTime() - new Date(newStart).getTime()) / 60000;
  if (
    service.hourly_rate != null &&
    service.manual_value == null &&
    service.upholstery_unit_price == null &&
    durationMin > 0
  ) {
    const ppl = newTeamId
      ? await getTeamSize(admin, newTeamId)
      : (service.num_people != null && service.num_people >= 1 ? service.num_people : 1);
    const value = calculateServiceValue({
      durationMin,
      hourlyRate: service.hourly_rate,
      numPeople: ppl,
      manualValue: null,
      fixedMonthly: false,
      contractFixedPrice: null,
      upholsteryUnits: null,
      upholsteryUnitPrice: null,
    });
    if (value != null) update.calculated_value = value;
    update.num_people = ppl;
  }

  const { error } = await admin
    .from("services")
    .update(update)
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

/**
 * Devolve os conflitos, ou `null` se não os conseguir apurar.
 *
 * O `null` existe para que o chamador não possa confundir "olhei e não há" com
 * "não consegui olhar". Era esse o defeito: o erro da consulta era ignorado,
 * a lista vinha vazia, e o serviço era remarcado por cima de outro.
 */
async function getConflicts(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
): Promise<ConflictInfo[] | null> {
  if (!newTeamId) return [];
  const dayStr = newStart.slice(0, 10);
  // Deteção de conflito. Ignorar o erro daria "sem conflitos" e o serviço
  // seria remarcado por cima de outro — o mesmo defeito que a T17-B2 encontrou
  // em fix-weekend-services.mjs, aqui em runtime.
  const { data: others, error: othersError } = await admin
    .from("services_full")
    .select("id, reference_number, location_name, scheduled_start, scheduled_end")
    .eq("company_id", companyId)
    .eq("team_id", newTeamId)
    .gte("scheduled_start", toLisbonTimestamp(dayStr, "00:00"))
    .lt("scheduled_start", toLisbonTimestamp(addDaysToDateString(dayStr, 1), "00:00"))
    .neq("id", serviceId)
    .in("status", ["agendado", "em_curso"]);

  if (othersError) {
    logQueryFailure("rescheduleService:conflicts", othersError);
    return null;
  }

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
