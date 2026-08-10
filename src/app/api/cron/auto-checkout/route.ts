import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/cron-auth";
import { logQueryFailure, QUERY_FAILURE_MESSAGE } from "@/lib/query-error";

export const maxDuration = 60;

// Máximo de timesheets a processar por chamada para não exceder o tempo limite.
const BATCH_LIMIT = 200;

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const now = new Date();

  // Processa timesheets em aberto; a janela por-empresa afina-se na lógica abaixo.
  // Limitar a BATCH_LIMIT para não saturar a execução.
  const { data: openTimesheets, error: tsErr } = await admin
    .from("timesheets")
    .select("id, service_id, clock_in_at, company_id")
    .is("clock_out_at", null)
    .limit(BATCH_LIMIT);

  if (tsErr) {
    return NextResponse.json({ error: tsErr.message }, { status: 500 });
  }
  if (!openTimesheets?.length) {
    return NextResponse.json({ ok: true, closed: 0 });
  }

  // Uma query para as settings de todas as empresas envolvidas.
  const companyIds = [...new Set(openTimesheets.map((t) => t.company_id))];
  // Define a tolerância de fecho automático por empresa. Falhando, todas caem
  // no valor por omissão e pontos são fechados mais cedo do que a empresa
  // configurou — sem nada a indicar porquê.
  const { data: settingsRows, error: settingsError } = await admin
    .from("company_settings")
    .select("company_id, checkout_after_minutes")
    .in("company_id", companyIds);
  if (settingsError) {
    logQueryFailure("autoCheckout:settings", settingsError);
    return NextResponse.json({ error: QUERY_FAILURE_MESSAGE }, { status: 503 });
  }

  const settingsMap: Record<string, number> = {};
  for (const row of settingsRows ?? []) {
    const minutes = (row as { company_id: string; checkout_after_minutes?: number | null }).checkout_after_minutes;
    settingsMap[row.company_id] = minutes ?? 60;
  }

  // Uma query para o scheduled_end de todos os serviços envolvidos.
  const serviceIds = [...new Set(openTimesheets.map((t) => t.service_id))];
  // O fim previsto de cada serviço decide QUANDO o ponto é fechado. Sem ele,
  // o mapa fica vazio e a hora de fecho é inventada.
  const { data: services, error: servicesError } = await admin
    .from("services")
    .select("id, scheduled_end")
    .in("id", serviceIds);
  if (servicesError) {
    logQueryFailure("autoCheckout:services", servicesError);
    return NextResponse.json({ error: QUERY_FAILURE_MESSAGE }, { status: 503 });
  }

  const serviceEndMap: Record<string, string | null> = {};
  for (const svc of services ?? []) {
    serviceEndMap[svc.id] = svc.scheduled_end ?? null;
  }

  // Separar os timesheets que passaram o prazo.
  const toClose: Array<{
    id: string;
    service_id: string;
    clockOutAt: Date;
    durationMin: number;
  }> = [];

  for (const ts of openTimesheets) {
    const scheduledEnd = serviceEndMap[ts.service_id];
    if (!scheduledEnd) continue;

    const checkoutLimit = settingsMap[ts.company_id] ?? 60;
    const deadline = new Date(scheduledEnd);
    deadline.setMinutes(deadline.getMinutes() + checkoutLimit);
    if (now < deadline) continue;

    const clockInAt = ts.clock_in_at ? new Date(ts.clock_in_at) : now;
    const plannedEnd = new Date(scheduledEnd);
    const clockOutAt = plannedEnd > clockInAt ? plannedEnd : now;
    const durationMin = Math.max(
      0,
      Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60_000),
    );

    toClose.push({ id: ts.id, service_id: ts.service_id, clockOutAt, durationMin });
  }

  if (toClose.length === 0) {
    return NextResponse.json({ ok: true, closed: 0 });
  }

  // Fechar um por um (Supabase não suporta bulk update com valores distintos por linha)
  // mas agrupamos o check "todos saíram?" por serviço ao final, não após cada update.
  const errors: string[] = [];
  let closed = 0;

  for (const item of toClose) {
    const { error: updateErr } = await admin
      .from("timesheets")
      .update({
        clock_out_at: item.clockOutAt.toISOString(),
        duration_minutes: item.durationMin,
        notes: "Auto-encerrado pelo sistema (saída registada no fim previsto do serviço)",
      })
      .eq("id", item.id);

    if (updateErr) {
      errors.push(`ts=${item.id}: ${updateErr.message}`);
    } else {
      closed++;
    }
  }

  // Verificar serviços onde já não há timesheets abertos — uma query por serviço,
  // mas apenas para os serviços cujos timesheets fechámos com sucesso.
  const closedServiceIds = [...new Set(
    toClose
      .filter((item) => !errors.some((e) => e.startsWith(`ts=${item.id}`)))
      .map((item) => item.service_id),
  )];

  for (const svcId of closedServiceIds) {
    const scheduledEnd = serviceEndMap[svcId];
    if (!scheduledEnd) continue;

    // Verificar timesheets abertos E total de timesheets.
    // Exigir pelo menos 1 timesheet para concluir (garante que alguém bateu ponto).
    const [{ count: openCount }, { count: totalCount }] = await Promise.all([
      admin.from("timesheets").select("id", { count: "exact", head: true })
        .eq("service_id", svcId).is("clock_out_at", null),
      admin.from("timesheets").select("id", { count: "exact", head: true })
        .eq("service_id", svcId),
    ]);

    if ((openCount ?? 1) === 0 && (totalCount ?? 0) > 0) {
      const clockOutAt = toClose.find((t) => t.service_id === svcId)?.clockOutAt ?? now;
      await admin
        .from("services")
        .update({ actual_end: clockOutAt.toISOString(), status: "concluido" })
        .eq("id", svcId);
    }
  }

  return NextResponse.json({
    ok: true,
    closed,
    checked: openTimesheets.length,
    errors: errors.length > 0 ? errors : undefined,
    truncated: openTimesheets.length === BATCH_LIMIT,
  });
}
