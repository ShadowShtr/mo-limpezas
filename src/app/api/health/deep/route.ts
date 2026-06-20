import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Diagnóstico profundo — apenas para admin/gestor autenticado.
// Testa DB, storage e variáveis de ambiente essenciais.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // ── DB ────────────────────────────────────────────────────────────────────────
  const dbStart = Date.now();
  try {
    const { error } = await admin.from("companies").select("id").limit(1);
    checks.db = { ok: !error, latencyMs: Date.now() - dbStart, error: error?.message };
  } catch (e) {
    checks.db = { ok: false, error: String(e) };
  }

  // ── Storage (bucket service-photos) ──────────────────────────────────────────
  const storageStart = Date.now();
  try {
    const { error } = await admin.storage.from("service-photos").list("", { limit: 1 });
    checks.storage = { ok: !error, latencyMs: Date.now() - storageStart, error: error?.message };
  } catch (e) {
    checks.storage = { ok: false, error: String(e) };
  }

  // ── Env vars essenciais ───────────────────────────────────────────────────────
  const requiredEnvs = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "RESEND_API_KEY",
    "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  ];
  const missingEnvs = requiredEnvs.filter((k) => !process.env[k]);
  checks.env = { ok: missingEnvs.length === 0, error: missingEnvs.length > 0 ? `Missing: ${missingEnvs.join(", ")}` : undefined };

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { ok: allOk, checks, ts: new Date().toISOString() },
    { status: allOk ? 200 : 503 },
  );
}
