"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

/** Lista as notificações do utilizador autenticado (RLS restringe a auth.uid()). */
export async function getMyNotifications(): Promise<AppNotification[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, data, read_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  return (data as AppNotification[]) ?? [];
}

/** Marca uma notificação como lida. */
export async function markNotificationRead(id: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("read_at", null);

  revalidatePath("/app/notificacoes");
  return { ok: true };
}

/** Marca todas as notificações do utilizador como lidas. */
export async function markAllNotificationsRead(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);

  revalidatePath("/app/notificacoes");
  return { ok: true };
}

/** Elimina uma notificação do utilizador autenticado. */
export async function deleteNotification(id: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  await supabase.from("notifications").delete().eq("id", id).eq("user_id", user.id);
  revalidatePath("/app/notificacoes");
  return { ok: true };
}

/** Elimina todas as notificações já lidas do utilizador. */
export async function deleteAllReadNotifications(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  await supabase.from("notifications").delete().eq("user_id", user.id).not("read_at", "is", null);
  revalidatePath("/app/notificacoes");
  return { ok: true };
}

export async function notifyTeam(serviceId: string, message: string) {
  // ── Wrapper global: garante que NUNCA lança exceção ──────────────────────────
  try {
    return await _notifyTeam(serviceId, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[notifyTeam] uncaught:", err);
    return { ok: false as const, error: msg, sent: 0 };
  }
}

async function _notifyTeam(serviceId: string, message: string) {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado.", sent: 0 };

  const { data: sender } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();

  if (!sender || !["admin", "gestor"].includes(sender.role)) {
    return { ok: false as const, error: "Sem permissão.", sent: 0 };
  }

  const { data: svc } = await admin
    .from("services")
    .select("team_id, scheduled_start, location_id")
    .eq("id", serviceId)
    .single();

  if (!svc?.team_id) return { ok: false as const, error: "Serviço sem equipa.", sent: 0 };

  const { data: members } = await admin
    .from("team_members")
    .select("collaborator_id")
    .eq("team_id", svc.team_id)
    .is("left_at", null);

  if (!members?.length) return { ok: true as const, sent: 0 };

  const memberIds = members.map((m) => m.collaborator_id);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth_key")
    .in("user_id", memberIds)
    .eq("company_id", sender.company_id);

  if (!subs?.length) return { ok: true as const, sent: 0 };

  // Verificar VAPID keys
  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;

  if (!vapidPublic || !vapidPrivate) {
    return {
      ok: false as const,
      error: "VAPID keys não configuradas. Adiciona NEXT_PUBLIC_VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY nas Environment Variables do Vercel.",
      sent: 0,
    };
  }

  let webpushMod: typeof import("web-push");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webpushMod = ((await import("web-push")) as any).default ?? (await import("web-push"));
    webpushMod.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);
  } catch (err) {
    return {
      ok: false as const,
      error: `Erro ao inicializar web-push: ${err instanceof Error ? err.message : "erro desconhecido"}`,
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
      webpushMod.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload,
      ),
    ),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  return { ok: true as const, sent };
}
