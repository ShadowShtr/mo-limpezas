"use server";

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
    .select("id, company_id, status, scheduled_start, team_id, location_id")
    .eq("id", serviceId)
    .single();

  if (svcErr || !svc) return { ok: false, error: "Serviço não encontrado." };
  if (svc.company_id !== profile.company_id) return { ok: false, error: "Sem permissão." };
  if (svc.status === "cancelado") return { ok: false, error: "Serviço já está cancelado." };

  // Detectar cancelamento tardio (<24h de antecedência)
  const hoursUntilService = (new Date(svc.scheduled_start).getTime() - Date.now()) / 3_600_000;
  const isLate = hoursUntilService < 24 && hoursUntilService > -24;

  const { error: updateErr } = await admin.from("services")
    .update({
      status:         "cancelado",
      cancel_type:    cancelType,
      cancel_reason:  cancelReason.trim() || null,
      cancelled_at:   new Date().toISOString(),
      cancelled_by:   user.id,
      is_late_cancel: isLate,
    })
    .eq("id", serviceId);

  if (updateErr) return { ok: false, error: updateErr.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "service_cancelled",
    entityType: "service",
    entityId: serviceId,
    before: { status: svc.status },
    after: { status: "cancelado", cancel_type: cancelType, is_late_cancel: isLate },
    meta: { reason: cancelReason.trim() || null },
    source: "dashboard",
  }, admin);

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
