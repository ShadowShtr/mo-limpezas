import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/payload-guard";

const subscribeSchema = z.object({
  endpoint: z.url("endpoint inválido.").max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Faltava rate limit nesta rota — única autenticada do lote sem ele.
  const limited = await rateLimit(rateLimitKey("push-subscribe", user.id), 20, 60_000);
  if (limited) return limited;

  const parsed = await parseJsonBody(req, subscribeSchema);
  if (!parsed.ok) return parsed.response;
  const { endpoint, keys } = parsed.data;

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (!profile) return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  await admin.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      company_id: profile.company_id,
      endpoint,
      p256dh: keys.p256dh,
      auth_key: keys.auth,
      user_agent: req.headers.get("user-agent") ?? null,
    },
    { onConflict: "user_id,endpoint" }
  );

  return NextResponse.json({ ok: true });
}
