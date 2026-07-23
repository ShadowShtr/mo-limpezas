import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Notifica um único utilizador: grava sempre uma notificação in-app
 * (aparece no sino) e tenta também Web Push, se houver subscrição e VAPID
 * configurado. Nunca lança — falhas de push são silenciosas, a notificação
 * in-app é o canal garantido. Mesmo padrão de notifyDayTeam em
 * src/app/actions/vehicles.ts, generalizado para qualquer tipo de aviso.
 */
export async function notifyUser(
  admin: AdminClient,
  args: {
    companyId: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
    url?: string;
  },
): Promise<{ notified: boolean }> {
  await admin
    .from("notifications")
    .insert({
      company_id: args.companyId,
      user_id: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      data: args.data ?? null,
    })
    .then(() => null, () => null);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", args.userId)
    .eq("company_id", args.companyId);

  if (!subs?.length) return { notified: false };

  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return { notified: false };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webpushMod = ((await import("web-push")) as any).default ?? (await import("web-push"));
    webpushMod.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);

    const payload = JSON.stringify({ title: args.title, body: args.body, url: args.url ?? "/dashboard" });
    const results = await Promise.allSettled(
      (subs as { endpoint: string; p256dh: string; auth_key: string }[]).map((s) =>
        webpushMod.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        ),
      ),
    );
    return { notified: results.some((r) => r.status === "fulfilled") };
  } catch (err) {
    console.error("[notifyUser] push falhou:", err);
    return { notified: false };
  }
}

/**
 * Push de CONTROLO (não é uma notificação para o utilizador ver) — pede à
 * app da colaboradora para verificar e aplicar uma atualização pendente
 * agora, em vez de esperar pela próxima vez que a app for para segundo
 * plano. Não grava nada em `notifications` (não é um aviso). O sw.js
 * reconhece `type: "force_update"` e nunca mostra uma notificação visível
 * por causa disto — ver public/sw.js.
 *
 * Só serve de nudge: continua a depender de o telemóvel entregar o push
 * (a app pode estar completamente fechada, sem garantias do SO). Se não
 * resolver, a colaboradora tem de reinstalar a app manualmente.
 */
export async function sendForceUpdatePush(
  admin: AdminClient,
  args: { companyId: string; userId: string },
): Promise<{ sent: number }> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", args.userId)
    .eq("company_id", args.companyId);

  if (!subs?.length) return { sent: 0 };

  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return { sent: 0 };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webpushMod = ((await import("web-push")) as any).default ?? (await import("web-push"));
    webpushMod.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);

    const payload = JSON.stringify({ type: "force_update" });
    const results = await Promise.allSettled(
      (subs as { endpoint: string; p256dh: string; auth_key: string }[]).map((s) =>
        webpushMod.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        ),
      ),
    );
    return { sent: results.filter((r) => r.status === "fulfilled").length };
  } catch (err) {
    console.error("[sendForceUpdatePush] push falhou:", err);
    return { sent: 0 };
  }
}
