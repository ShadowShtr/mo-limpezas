"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type CancelType =
  | "client_request"
  | "weather"
  | "operational"
  | "equipment"
  | "other";

export const CANCEL_TYPE_LABELS: Record<CancelType, string> = {
  client_request: "Pedido do cliente",
  weather:        "Condições climatéricas",
  operational:    "Problema operacional",
  equipment:      "Problema de equipamento",
  other:          "Outro motivo",
};

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

  // Actualizar serviço (cast para contornar tipos gerados antes da migration 019)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateErr } = await (admin.from("services") as any)
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

  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails(
    "mailto:admin@molimpezas.pt",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    process.env.VAPID_PRIVATE_KEY ?? "",
  );

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
