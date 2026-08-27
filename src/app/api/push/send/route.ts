import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/payload-guard";

const sendSchema = z.object({
  user_id: z.string().uuid("user_id inválido."),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  url: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  webpush.setVapidDetails(
    "mailto:admin@molimpezas.pt",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    process.env.VAPID_PRIVATE_KEY ?? ""
  );

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(req, sendSchema);
  if (!parsed.ok) return parsed.response;
  const { user_id, title, body, url } = parsed.data;

  const admin = createAdminClient();

  // Verificar que o remetente é gestor/admin da mesma empresa
  const { data: sender } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!sender || !["admin", "gestor"].includes(sender.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = await rateLimit(rateLimitKey("push-send", sender.company_id), 20, 60_000);
  if (limited) return limited;

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", user_id)
    .eq("company_id", sender.company_id);

  if (!subs?.length) {
    return NextResponse.json({ sent: 0 });
  }

  const payload = JSON.stringify({ title, body, url: url || "/app" });

  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload
      )
    )
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  return NextResponse.json({ sent });
}
