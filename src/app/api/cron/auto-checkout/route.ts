import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 });
  }
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();

  // Buscar todos os timesheets sem clock_out, com o serviço associado
  const { data: openTimesheets, error: tsErr } = await admin
    .from("timesheets")
    .select("id, service_id, clock_in_at, company_id")
    .is("clock_out_at", null);

  if (tsErr) {
    return NextResponse.json({ error: tsErr.message }, { status: 500 });
  }
  if (!openTimesheets?.length) {
    return NextResponse.json({ ok: true, closed: 0 });
  }

  // Agrupar por company_id para buscar settings de cada empresa uma vez só
  const companyIds = [...new Set(openTimesheets.map((t) => t.company_id))];
  const { data: settingsRows } = await admin
    .from("company_settings")
    .select("company_id, checkout_after_minutes")
    .in("company_id", companyIds);

  const settingsMap: Record<string, number> = {};
  for (const row of settingsRows ?? []) {
    const minutes = (row as { company_id: string; checkout_after_minutes?: number | null }).checkout_after_minutes;
    settingsMap[row.company_id] = minutes ?? 60;
  }

  // Buscar scheduled_end dos serviços em aberto
  const serviceIds = [...new Set(openTimesheets.map((t) => t.service_id))];
  const { data: services } = await admin
    .from("services")
    .select("id, scheduled_end")
    .in("id", serviceIds);

  const serviceEndMap: Record<string, string | null> = {};
  for (const svc of services ?? []) {
    serviceEndMap[svc.id] = svc.scheduled_end ?? null;
  }

  let closed = 0;
  const errors: string[] = [];

  for (const ts of openTimesheets) {
    const scheduledEnd = serviceEndMap[ts.service_id];
    if (!scheduledEnd) continue;

    const checkoutLimit = settingsMap[ts.company_id] ?? 60;
    const deadline = new Date(scheduledEnd);
    deadline.setMinutes(deadline.getMinutes() + checkoutLimit);

    if (now < deadline) continue;

    // Passou o prazo — forçar clock-out.
    // Gravar a saída na hora PREVISTA de fim do serviço (não na hora a que o cron
    // corre), para não inflacionar as horas trabalhadas se o cron correr muito
    // depois. O gestor pode afinar manualmente no Registo de Ponto.
    const clockInAt = ts.clock_in_at ? new Date(ts.clock_in_at) : now;
    const plannedEnd = new Date(scheduledEnd);
    // Nunca antes da entrada (evita duração negativa em casos estranhos)
    const clockOutAt = plannedEnd > clockInAt ? plannedEnd : now;
    const duration_minutes = Math.max(
      0,
      Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60_000),
    );

    const { error: updateErr } = await admin
      .from("timesheets")
      .update({
        clock_out_at: clockOutAt.toISOString(),
        duration_minutes,
        notes: "Auto-encerrado pelo sistema (saída registada no fim previsto do serviço)",
      })
      .eq("id", ts.id);

    if (updateErr) {
      errors.push(`ts=${ts.id}: ${updateErr.message}`);
      continue;
    }

    // Verificar se todos saíram para marcar serviço como concluído
    const { count } = await admin
      .from("timesheets")
      .select("id", { count: "exact", head: true })
      .eq("service_id", ts.service_id)
      .is("clock_out_at", null);

    if ((count ?? 0) === 0) {
      await admin
        .from("services")
        .update({ actual_end: clockOutAt.toISOString(), status: "concluido" })
        .eq("id", ts.service_id);
    }

    closed++;
  }

  return NextResponse.json({
    ok: true,
    closed,
    errors: errors.length > 0 ? errors : undefined,
  });
}
