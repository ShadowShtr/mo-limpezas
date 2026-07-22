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

  // Caminho preferido: RPC ATÓMICA (migração 062) — bookkeeping + delete numa
  // única transação; qualquer falha = rollback total, nunca estado meio-aplicado.
  // Também regista o ator (app.actor_id) nas entradas do data_history.
  const { data: rpcResult, error: rpcErr } = await admin.rpc("delete_calendar_service_safe", {
    p_service_id: serviceId,
    p_scope: scope === "all" && svc.contract_id ? "all" : "single",
    p_company_id: profile.company_id,
    p_actor: user.id,
  });

  if (!rpcErr) {
    deleted = (rpcResult as { deleted?: number } | null)?.deleted ?? 0;
    if (deleted === 0) {
      return { ok: false, error: "Nada foi eliminado. Atualize a página." };
    }
  } else if (rpcErr.code === "PGRST202" || /delete_calendar_service_safe/.test(rpcErr.message)) {
    // Fallback enquanto a migração 062 não estiver aplicada: mesma lógica SEM
    // transação, mas em ORDEM FAIL-SAFE — o bookkeeping vem PRIMEIRO, o delete
    // depois. Assim, qualquer estado parcial é inofensivo e re-tentável:
    // contrato arquivado/data excluída sem delete → repetir o delete resolve,
    // e nada pode ser recriado pelo cron no intervalo.
    if (scope === "all" && svc.contract_id) {
      const { data: archived, error: archErr } = await admin.from("contracts")
        .update({ status: "cancelado" })
        .eq("id", svc.contract_id).eq("company_id", profile.company_id)
        .select("id");
      if (archErr || !archived || archived.length === 0) {
        return { ok: false, error: `Não foi possível arquivar a recorrência (${archErr?.message ?? "0 linhas"}) — nada foi eliminado.` };
      }
      const { data: del, error: delErr } = await admin
        .from("services").delete()
        .eq("company_id", profile.company_id)
        .eq("contract_id", svc.contract_id)
        .select("id");
      if (delErr) return { ok: false, error: `A recorrência foi arquivada mas a eliminação falhou (${delErr.message}) — tente de novo (o cron NÃO vai recriar).` };
      deleted = del?.length ?? 0;
      if (deleted === 0) {
        return { ok: false, error: "Nada foi eliminado (as ocorrências já não existiam); a recorrência ficou arquivada." };
      }
    } else {
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
          const { data: exclUpd, error: exclErr } = await admin.from("contracts")
            .update({ excluded_dates: [...current, svcDate] })
            .eq("id", svc.contract_id).eq("company_id", profile.company_id)
            .select("id");
          if (exclErr || !exclUpd || exclUpd.length === 0) {
            return { ok: false, error: `Não foi possível registar a exceção no contrato (${exclErr?.message ?? "0 linhas"}) — nada foi eliminado.` };
          }
        }
      }
      const { data: del, error: delErr } = await admin
        .from("services").delete()
        .eq("id", serviceId)
        .eq("company_id", profile.company_id)
        .select("id");
      if (delErr) return { ok: false, error: `A exceção ficou registada mas a eliminação falhou (${delErr.message}) — tente de novo (o cron NÃO vai recriar este dia).` };
      deleted = del?.length ?? 0;
      if (deleted === 0) {
        return { ok: false, error: "Nada foi eliminado (o serviço já não existe). Atualize a página." };
      }
    }
  } else {
    return { ok: false, error: rpcErr.message };
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
