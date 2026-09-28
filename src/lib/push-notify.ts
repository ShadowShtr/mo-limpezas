import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Notifica um único utilizador: grava uma notificação in-app (aparece no sino)
 * e tenta também Web Push, se houver subscrição e VAPID configurado. Nunca
 * lança. Mesmo padrão de notifyDayTeam em src/app/actions/vehicles.ts,
 * generalizado para qualquer tipo de aviso.
 *
 * 🔴 `stored` existe porque esta função DIZIA que o in-app era o canal
 *    garantido e não tinha como saber se a gravação passou.
 *
 *    O INSERT terminava em `.then(() => null, () => null)`: os dois ramos
 *    descartados, sucesso e erro indistinguíveis. Quem chamasse recebia
 *    `{ notified }`, que fala só do Push — o canal best-effort. O canal
 *    durável, o único que a pessoa vê quando abre o sino, não era reportado
 *    por ninguém. Uma falha de escrita — chave expirada, RLS, tabela
 *    indisponível — passava por sucesso silencioso.
 *
 *    Para um aviso disparado por uma acção humana isso era tolerável: a pessoa
 *    está no ecrã e volta a tentar. Para um cron diário é o contrário — ninguém
 *    está a ver, e a única prova de que correu é a notificação existir. Um cron
 *    que devolve 200 sem ter gravado nada é pior do que um cron que falha.
 *
 *    Retrocompatível: o campo é NOVO e `notified` mantém o significado. Quem
 *    ignorava o retorno continua a ignorá-lo.
 *
 * 🔴 Sem gravação, não se envia Push.
 *
 *    Um Push sem linha no sino é um aviso que aparece no telemóvel e não existe
 *    em lado nenhum — não há onde o reler nem como o marcar como lido. Pior:
 *    numa retry, a dedupe olha para o que ficou GRAVADO, portanto um item que
 *    falhou a gravar volta a ser tentado, e sem esta ordem o telemóvel recebia
 *    o mesmo aviso a cada tentativa.
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
): Promise<{ stored: boolean; notified: boolean }> {
  let stored = false;
  try {
    const { error } = await admin
      .from("notifications")
      .insert({
        company_id: args.companyId,
        user_id: args.userId,
        type: args.type,
        title: args.title,
        body: args.body,
        data: args.data ?? null,
      });
    if (error) {
      console.error("[notifyUser] gravação da notificação falhou:", error.message);
    } else {
      stored = true;
    }
  } catch (err) {
    // A promessa de não lançar é o contrato desta função: há chamadores que a
    // invocam no meio de operações já concluídas, e rebentar aqui desfaria o
    // valor de um trabalho que correu bem.
    console.error("[notifyUser] gravação da notificação lançou:", err);
  }

  if (!stored) return { stored: false, notified: false };

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", args.userId)
    .eq("company_id", args.companyId);

  if (!subs?.length) return { stored, notified: false };

  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return { stored, notified: false };

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
    return { stored, notified: results.some((r) => r.status === "fulfilled") };
  } catch (err) {
    console.error("[notifyUser] push falhou:", err);
    return { stored, notified: false };
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
