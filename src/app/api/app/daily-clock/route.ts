import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit";

// Ponto GERAL do dia: entrada e saída únicas. É isto que conta para a folha.
type Action = "clock_in" | "clock_out";
const FIELD: Record<Action, "clock_in_at" | "clock_out_at"> = {
  clock_in: "clock_in_at",
  clock_out: "clock_out_at",
};

function parseCoord(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Data local de Lisboa (YYYY-MM-DD) para a chave do dia. */
function lisbonDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("daily-clock", user.id), 12, 60_000);
  if (limited) return limited;

  const body = await req.json();
  const action = body.action as Action;
  if (!FIELD[action]) return NextResponse.json({ error: "Ação inválida." }, { status: 400 });

  const lat = parseCoord(body.lat);
  const lng = parseCoord(body.lng);
  const nowIso = new Date().toISOString();

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return NextResponse.json({ error: "Perfil não encontrado." }, { status: 404 });

  const workDate = lisbonDate();

  // Garante a linha do dia.
  const { data: existing } = await admin
    .from("daily_clocks")
    .select("id, clock_in_at, clock_out_at")
    .eq("company_id", profile.company_id)
    .eq("collaborator_id", user.id)
    .eq("work_date", workDate)
    .maybeSingle();

  // Guardas de coerência.
  if (action === "clock_in" && existing?.clock_in_at) {
    return NextResponse.json({ error: "Já bateste o ponto de início hoje." }, { status: 409 });
  }
  if (action === "clock_out") {
    if (!existing?.clock_in_at) return NextResponse.json({ error: "Bate o ponto de início primeiro." }, { status: 409 });
    if (existing?.clock_out_at) return NextResponse.json({ error: "Já bateste o ponto de fim hoje." }, { status: 409 });
  }

  const field = FIELD[action];
  const patch: Record<string, unknown> = { [field]: nowIso, updated_at: nowIso };
  if (action === "clock_in") { patch.clock_in_lat = lat; patch.clock_in_lng = lng; }
  if (action === "clock_out") { patch.clock_out_lat = lat; patch.clock_out_lng = lng; }

  let row;
  if (existing) {
    const { data, error } = await admin
      .from("daily_clocks").update(patch as never).eq("id", existing.id).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    row = data;
  } else {
    const { data, error } = await admin
      .from("daily_clocks")
      .insert({ company_id: profile.company_id, collaborator_id: user.id, work_date: workDate, ...patch } as never)
      .select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    row = data;
  }

  await auditLog(
    { companyId: profile.company_id, actorId: user.id, action: `daily_clock.${action}`, entityType: "daily_clock", entityId: row.id, meta: { workDate }, source: "mobile" },
    admin,
  );

  return NextResponse.json({ data: row });
}
