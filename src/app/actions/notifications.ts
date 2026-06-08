"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function notifyTeam(serviceId: string, message: string) {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado.", sent: 0 };

  const { data: sender } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();

  if (!sender || !["admin", "gestor"].includes(sender.role)) {
    return { ok: false as const, error: "Sem permissão.", sent: 0 };
  }

  // Dados do serviço
  const { data: svc } = await admin
    .from("services")
    .select("team_id, scheduled_start, location_id")
    .eq("id", serviceId)
    .single();

  if (!svc?.team_id) return { ok: false as const, error: "Serviço sem equipa.", sent: 0 };

  // Membros da equipa
  const { data: members } = await admin
    .from("team_members")
    .select("collaborator_id")
    .eq("team_id", svc.team_id)
    .is("left_at", null);

  if (!members?.length) return { ok: true as const, sent: 0 };

  const memberIds = members.map((m) => m.collaborator_id);

  // Subscrições push de cada membro
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth_key")
    .in("user_id", memberIds)
    .eq("company_id", sender.company_id);

  if (!subs?.length) return { ok: true as const, sent: 0 };

  // Verificar VAPID keys antes de importar web-push
  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;

  if (!vapidPublic || !vapidPrivate) {
    return { ok: false as const, error: "VAPID keys não configuradas no servidor.", sent: 0 };
  }

  let webpush: typeof import("web-push");
  try {
    webpush = (await import("web-push")).default;
    webpush.setVapidDetails(
      "mailto:admin@molimpezas.pt",
      vapidPublic,
      vapidPrivate,
    );
  } catch (err) {
    return {
      ok: false as const,
      error: `Erro ao configurar notificações push: ${err instanceof Error ? err.message : "erro desconhecido"}`,
      sent: 0,
    };
  }

  const payload = JSON.stringify({
    title: "📋 Notificação de serviço",
    body: message,
    url: `/app/servico/${serviceId}`,
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
  return { ok: true as const, sent };
}
