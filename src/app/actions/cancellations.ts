"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { CANCEL_TYPE_LABELS } from "@/lib/cancel-types";
import type { CancelType } from "@/lib/cancel-types";
import { auditLog } from "@/lib/audit";

export async function cancelService(
  serviceId: string,
  cancelType: CancelType,
  cancelReason: string,
  notifyTeamMembers: boolean,
): Promise<{ ok: boolean; error?: string; isLate?: boolean; sent?: number }> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role, full_name")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  // Buscar dados do serviço
  const { data: svc, error: svcErr } = await admin
    .from("services")
    .select("id, company_id, status, scheduled_start, team_id, location_id, contract_id, is_exception")
    .eq("id", serviceId)
    .single();

  if (svcErr || !svc) return { ok: false, error: "Serviço não encontrado." };
  if (svc.company_id !== profile.company_id) return { ok: false, error: "Sem permissão." };
  if (svc.status === "cancelado") return { ok: false, error: "Serviço já está cancelado." };

  // Detectar cancelamento tardio (<24h de antecedência)
  const hoursUntilService = (new Date(svc.scheduled_start).getTime() - Date.now()) / 3_600_000;
  const isLate = hoursUntilService < 24 && hoursUntilService > -24;

  // Cancelamento manual de serviço de contrato também é exceção — nenhum
  // automatismo pode "descancelar" o que a gestora cancelou à mão.
  const cancelUpdate: {
    status: string; cancel_type: CancelType; cancel_reason: string | null;
    cancelled_at: string; cancelled_by: string; is_late_cancel: boolean;
    is_exception?: boolean;
  } = {
    status:         "cancelado",
    cancel_type:    cancelType,
    cancel_reason:  cancelReason.trim() || null,
    cancelled_at:   new Date().toISOString(),
    cancelled_by:   user.id,
    is_late_cancel: isLate,
  };
  if (svc.contract_id != null) cancelUpdate.is_exception = true;

  const { data: cancelled, error: updateErr } = await admin.from("services")
    .update(cancelUpdate)
    .eq("id", serviceId)
    .eq("company_id", profile.company_id)
    .select("id");

  if (updateErr) return { ok: false, error: updateErr.message };
  if (!cancelled || cancelled.length === 0) {
    return { ok: false, error: "Nada foi cancelado (o serviço já não existe ou não pertence à empresa). Atualize a página." };
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "service_cancelled",
    entityType: "service",
    entityId: serviceId,
    before: { status: svc.status, is_exception: svc.is_exception },
    after: { status: "cancelado", cancel_type: cancelType, is_late_cancel: isLate, is_exception: cancelUpdate.is_exception ?? svc.is_exception },
    meta: { reason: cancelReason.trim() || null },
    source: "dashboard",
  }, admin);

  // Revalidar SEMPRE antes de qualquer return dos caminhos de notificação —
  // sem isto, "cancelei e o calendário/ficha do cliente não mostram".
  const { data: cancelLoc } = await admin
    .from("locations").select("client_id").eq("id", svc.location_id).maybeSingle();
  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/cobrancas");
  if (cancelLoc?.client_id) revalidatePath(`/dashboard/clientes/${cancelLoc.client_id}`);

  if (!notifyTeamMembers || !svc.team_id) {
    return { ok: true, isLate, sent: 0 };
  }

  // Notificar membros da equipa via push
  const { data: members } = await admin
    .from("team_members")
    .select("collaborator_id")
    .eq("team_id", svc.team_id)
    .is("left_at", null);

  if (!members?.length) return { ok: true, isLate, sent: 0 };

  const memberIds = members.map((m) => m.collaborator_id);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .in("user_id", memberIds)
    .eq("company_id", profile.company_id);

  if (!subs?.length) return { ok: true, isLate, sent: 0 };

  const { data: location } = await admin
    .from("locations")
    .select("name")
    .eq("id", svc.location_id)
    .single();

  const serviceName = location?.name ?? "Serviço";
  const motivo = CANCEL_TYPE_LABELS[cancelType];
  const body = isLate
    ? `⚠️ Cancelamento tardio: ${serviceName} foi cancelado. Motivo: ${motivo}.`
    : `${serviceName} foi cancelado. Motivo: ${motivo}.`;

  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return { ok: true, isLate, sent: 0 };

  let webpush: typeof import("web-push");
  try {
    webpush = (await import("web-push")).default;
    webpush.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);
  } catch {
    return { ok: true, isLate, sent: 0 };
  }

  const payload = JSON.stringify({
    title: "🚫 Serviço cancelado",
    body,
    url: `/app`,
  });

  const results = await Promise.allSettled(
    subs.map((s: { endpoint: string; p256dh: string; auth_key: string }) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload,
      ),
    ),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  return { ok: true, isLate, sent };
}

/**
 * Exclui serviços do calendário (e da app das funcionárias). Diferente de
 * cancelar: o serviço desaparece de tudo (não fica "cancelado").
 * - scope "single": apaga só ESTA ocorrência.
 * - scope "all": apaga TODAS as ocorrências da intervenção recorrente (passadas
 *   e futuras) e arquiva a intervenção para não voltar a gerar. Num serviço
 *   pontual, "all" é igual a "single".
 */
export async function deleteCalendarService(
  serviceId: string,
  scope: "single" | "all" = "single",
): Promise<{ ok: true; deleted: number; recurring: boolean } | { ok: false; error: string }> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  const { data: svc } = await admin
    .from("services")
    .select("id, company_id, contract_id, scheduled_start, location_id")
    .eq("id", serviceId)
    .eq("company_id", profile.company_id)
    .single();
  if (!svc) return { ok: false, error: "Serviço não encontrado." };

  let deleted = 0;
  const recurring = !!svc.contract_id;

  if (scope === "all" && svc.contract_id) {
    // Apaga TODAS as ocorrências da intervenção e arquiva a recorrência.
    const { data: del, error: delErr } = await admin
      .from("services").delete()
      .eq("company_id", profile.company_id)
      .eq("contract_id", svc.contract_id)
      .select("id");
    if (delErr) return { ok: false, error: delErr.message };
    deleted = del?.length ?? 0;
    if (deleted === 0) {
      return { ok: false, error: "Nada foi eliminado (as ocorrências já não existem). Atualize a página." };
    }
    // Arquivar a recorrência TEM de ser confirmado — sem isto o cron mensal
    // regenerava as ocorrências e a intervenção "voltava sozinha".
    const { data: archived, error: archErr } = await admin.from("contracts")
      .update({ status: "cancelado" })
      .eq("id", svc.contract_id).eq("company_id", profile.company_id)
      .select("id");
    if (archErr || !archived || archived.length === 0) {
      return { ok: false, error: `As ocorrências foram eliminadas mas o arquivo da recorrência FALHOU (${archErr?.message ?? "0 linhas"}) — sem isto o cron pode recriá-las. Tente cancelar o contrato manualmente.` };
    }
  } else {
    // Só esta ocorrência: apaga a linha e, se for recorrente, regista a data como
    // exceção PERMANENTE no contrato (excluded_dates). Assim a geração (cron mensal
    // e ao editar o contrato) nunca recria este dia.
    const { data: del, error: delErr } = await admin
      .from("services").delete()
      .eq("id", serviceId)
      .eq("company_id", profile.company_id)
      .select("id");
    if (delErr) return { ok: false, error: delErr.message };
    deleted = del?.length ?? 0;
    if (deleted === 0) {
      return { ok: false, error: "Nada foi eliminado (o serviço já não existe). Atualize a página." };
    }

    if (svc.contract_id) {
      const svcDate = (svc.scheduled_start as string).slice(0, 10); // YYYY-MM-DD
      const { data: contract } = await admin
        .from("contracts")
        .select("excluded_dates")
        .eq("id", svc.contract_id)
        .eq("company_id", profile.company_id)
        .single();
      const current = (contract?.excluded_dates as string[] | null) ?? [];
      if (!current.includes(svcDate)) {
        // Confirmado: sem esta gravação o cron recria o dia apagado.
        const { data: exclUpd, error: exclErr } = await admin.from("contracts")
          .update({ excluded_dates: [...current, svcDate] })
          .eq("id", svc.contract_id).eq("company_id", profile.company_id)
          .select("id");
        if (exclErr || !exclUpd || exclUpd.length === 0) {
          return { ok: false, error: `O serviço foi eliminado mas a data NÃO ficou registada como exceção no contrato (${exclErr?.message ?? "0 linhas"}) — o cron mensal pode recriar este dia. Tente novamente ou registe a exceção no contrato.` };
        }
      }
    }
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "service.deleted_from_calendar",
    entityType: "service",
    entityId: serviceId,
    meta: { recurring, deleted, scope, contract_id: svc.contract_id },
    source: "dashboard",
  }, admin);

  const { data: loc } = await admin
    .from("locations").select("client_id").eq("id", svc.location_id).maybeSingle();
  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/cobrancas");
  if (loc?.client_id) revalidatePath(`/dashboard/clientes/${loc.client_id}`);

  return { ok: true, deleted, recurring };
}
