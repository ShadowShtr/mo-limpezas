import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeepHealthReport } from "@/lib/deep-health";

// Diagnóstico profundo — apenas para admin/gestor autenticado.
// Testa DB, storage, migration ledger real, backend de rate limit e
// existência do outbox (company_change_events) — ver plano de correção T01.
// Lógica dos checks vive em src/lib/deep-health.ts, partilhada com a página
// /dashboard/sistema/diagnostico (nunca duplicar).
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

  const report = await getDeepHealthReport();
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
