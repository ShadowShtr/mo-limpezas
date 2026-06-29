import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanySettings } from "@/app/actions/settings";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { haversineDistanceM } from "@/lib/calculations";
import { withRouteMetrics } from "@/lib/observability/route-metrics";
import { auditLog } from "@/lib/audit";

// Pontos offline aceites até 48h no passado; mais antigos vão para revisão automática
const MAX_OFFLINE_AGE_MS = 48 * 60 * 60 * 1000;

function parseCoord(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valida timestamp do cliente (registo offline).
 * Devolve { ts: ISO, tooOld: boolean }.
 */
function parsePastTimestamp(value: unknown): { ts: string; tooOld: boolean } {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t <= Date.now() + 60_000) {
      return { ts: new Date(t).toISOString(), tooOld: Date.now() - t > MAX_OFFLINE_AGE_MS };
    }
  }
  return { ts: new Date().toISOString(), tooOld: false };
}

async function logAudit(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  actorId: string,
  action: string,
  entityId: string,
  meta: Record<string, unknown>
) {
  await auditLog(
    { companyId, actorId, action, entityType: "timesheet", entityId, meta, source: "mobile" },
    admin,
  );
}

async function postHandler(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit separado para clock-in (menos tolerante a repetição rápida)
  const limited = await rateLimit(rateLimitKey("timesheet-in", user.id), 6, 60_000);
  if (limited) return limited;

  const {
    service_id,
    lat: rawLat, lng: rawLng,
    clock_in_at: rawClockIn,
    manual,
    gps_accuracy,
    client_event_id,
  } = await req.json();

  const lat = parseCoord(rawLat);
  const lng = parseCoord(rawLng);

  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });
  if ((lat == null || lng == null) && !manual) {
    return NextResponse.json(
      { error: "Ative a localização/GPS para registar o ponto.", needsManualConfirm: true },
      { status: 400 }
    );
  }

  const { ts: clockInAt, tooOld } = parsePastTimestamp(rawClockIn);

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile)
    return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  // Gate: exige o ponto GERAL de início do dia antes de bater ponto em serviços.
  const lisbonDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const { data: dayClock } = await admin
    .from("daily_clocks")
    .select("clock_in_at")
    .eq("collaborator_id", user.id)
    .eq("work_date", lisbonDate)
    .maybeSingle();
  if (!dayClock?.clock_in_at) {
    return NextResponse.json(
      { error: "Bate o ponto de início do dia (aba Ponto) antes de registar pontos nos serviços.", needsDailyClockIn: true },
      { status: 409 },
    );
  }

  const { data: service } = await admin
    .from("services_full")
    .select("id, company_id, team_id, location_lat, location_lng, scheduled_start, scheduled_end, status")
    .eq("id", service_id)
    .eq("company_id", profile.company_id)
    .single();

  if (!service)
    return NextResponse.json({ error: "Serviço não encontrado" }, { status: 404 });

  // Bloquear clock-in em serviços terminados ou cancelados
  if (["cancelado", "concluido", "arquivado"].includes(service.status ?? "")) {
    return NextResponse.json(
      { error: `Este serviço está ${service.status} e não aceita mais pontos.` },
      { status: 409 }
    );
  }

  const [{ data: membership }, { data: reinforcement }, settings] = await Promise.all([
    service.team_id
      ? admin.from("team_members").select("id").eq("team_id", service.team_id).eq("collaborator_id", user.id).is("left_at", null).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("service_reinforcements").select("id").eq("service_id", service_id).eq("collaborator_id", user.id).maybeSingle(),
    getCompanySettings(profile.company_id),
  ]);

  if (!membership && !reinforcement)
    return NextResponse.json({ error: "Sem permissão para este serviço" }, { status: 403 });

  // Sem limite de tempo para clock-in: as colaboradoras podem bater ponto a
  // qualquer hora, inclusive atrasadas. O gestor pode afinar no Registo de Ponto.

  let distance_m: number | null = null;
  let location_warning = false;
  if (lat != null && lng != null && service.location_lat != null && service.location_lng != null) {
    distance_m = Math.round(haversineDistanceM(lat, lng, Number(service.location_lat), Number(service.location_lng)));
    location_warning = distance_m > settings.gps_radius_meters;
  }

  // Guard: ponto aberto para este serviço (double clock-in)
  const { data: dupOpen } = await admin
    .from("timesheets").select("id").eq("service_id", service_id).eq("collaborator_id", user.id).is("clock_out_at", null).maybeSingle();
  if (dupOpen)
    return NextResponse.json({ error: "Já tem um ponto aberto para este serviço. Registe a saída primeiro." }, { status: 409 });

  // Guard: ponto aberto noutro serviço
  const { data: openElsewhere } = await admin
    .from("timesheets").select("id").eq("collaborator_id", user.id).is("clock_out_at", null).neq("service_id", service_id).maybeSingle();
  if (openElsewhere)
    return NextResponse.json({ error: "Tem um ponto aberto noutro serviço. Registe a saída nesse serviço antes de iniciar um novo." }, { status: 409 });

  const insertPayload = {
    service_id,
    collaborator_id: user.id,
    company_id: profile.company_id,
    clock_in_at: clockInAt,
    clock_in_lat: lat,
    clock_in_lng: lng,
    clock_in_distance_m: distance_m,
    location_warning: manual ? true : location_warning,
    manual_checkin: manual ?? false,
    gps_accuracy_m: gps_accuracy ?? null,
    ...(client_event_id ? { client_event_id } : {}),
  };

  // Upsert com idempotência: se client_event_id já existe, ignorar silenciosamente.
  const { data, error } = await admin
    .from("timesheets")
    .upsert(insertPayload, { onConflict: "client_event_id", ignoreDuplicates: true })
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // data é null quando o upsert ignorou duplicado — considerar sucesso
  if (!data) {
    return NextResponse.json({ data: null, duplicate: true, distance_m, location_warning });
  }

  await admin.from("services").update({ actual_start: clockInAt, status: "em_curso" }).eq("id", service_id).is("actual_start", null);

  if (manual) {
    await logAudit(admin, profile.company_id, user.id, "timesheet.manual_checkin", data.id, {
      service_id, gps_accuracy, reason: "GPS indisponível/impreciso confirmado pela colaboradora",
      tooOld, ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
  }

  if (tooOld) {
    await logAudit(admin, profile.company_id, user.id, "timesheet.late_sync", data.id, {
      service_id, clock_in_at: clockInAt, delay_hours: Math.round((Date.now() - new Date(clockInAt).getTime()) / 3_600_000),
    });
  }

  return NextResponse.json({ data, distance_m, location_warning, tooOld });
}

async function patchHandler(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("timesheet-out", user.id), 6, 60_000);
  if (limited) return limited;

  const {
    service_id,
    lat: rawLat, lng: rawLng,
    clock_out_at: rawClockOut,
    manual,
    gps_accuracy,
  } = await req.json();

  const lat = parseCoord(rawLat);
  const lng = parseCoord(rawLng);

  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });
  if ((lat == null || lng == null) && !manual) {
    return NextResponse.json(
      { error: "Ative a localização/GPS para registar o ponto.", needsManualConfirm: true },
      { status: 400 }
    );
  }

  const { ts: clockOutAt, tooOld } = parsePastTimestamp(rawClockOut);

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile)
    return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  const { data: ts } = await admin
    .from("timesheets")
    .select("id, clock_in_at")
    .eq("service_id", service_id)
    .eq("collaborator_id", user.id)
    .is("clock_out_at", null)
    .single();

  if (!ts)
    return NextResponse.json({ error: "Registo de entrada não encontrado" }, { status: 404 });

  // Sem limite de tempo para clock-out: o ponto pode ser fechado a qualquer hora.

  const out = new Date(clockOutAt);
  const duration_minutes = ts.clock_in_at
    ? Math.max(0, Math.round((out.getTime() - new Date(ts.clock_in_at).getTime()) / 60000))
    : 0;

  // Calcular distância no checkout para simetria com o clock-in.
  let checkout_distance_m: number | null = null;
  let checkout_location_warning = false;
  if (lat != null && lng != null) {
    const { data: svc } = await admin
      .from("services")
      .select("location_id, locations(lat, lng)")
      .eq("id", service_id)
      .single();
    const loc = (svc?.locations as unknown as { lat: number | null; lng: number | null } | null);
    if (loc?.lat != null && loc?.lng != null) {
      const settings = await getCompanySettings(profile.company_id);
      const radius = settings?.gps_radius_meters ?? 500;
      checkout_distance_m = Math.round(haversineDistanceM(lat, lng, loc.lat, loc.lng));
      checkout_location_warning = checkout_distance_m > radius;
    }
  }

  // Incluir .is("clock_out_at", null) no update para evitar checkout duplicado em corrida paralela
  const { data, error } = await admin
    .from("timesheets")
    .update({
      clock_out_at: clockOutAt,
      clock_out_lat: lat,
      clock_out_lng: lng,
      duration_minutes,
      // fields added by migration 032 — cast until types are regenerated
      ...(({
        manual_checkout: manual ?? false,
        clock_out_distance_m: checkout_distance_m,
        clock_out_accuracy_m: gps_accuracy ?? null,
        clock_out_location_warning: checkout_location_warning,
      }) as unknown as object),
    })
    .eq("id", ts.id)
    .is("clock_out_at", null) // guard de corrida: só actualiza se ainda estiver aberto
    .select();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data || data.length === 0) {
    // Outro pedido chegou primeiro e fechou o ponto — tratar como duplicado
    return NextResponse.json({ duplicate: true, duration_minutes }, { status: 409 });
  }

  const updatedTs = data[0];

  if (manual) {
    await logAudit(admin, profile.company_id, user.id, "timesheet.manual_checkout", ts.id, {
      service_id, gps_accuracy, reason: "GPS indisponível/impreciso confirmado pela colaboradora",
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
  }

  const [{ count: openCount }, { count: totalCount }] = await Promise.all([
    admin.from("timesheets").select("id", { count: "exact", head: true })
      .eq("service_id", service_id).is("clock_out_at", null),
    admin.from("timesheets").select("id", { count: "exact", head: true })
      .eq("service_id", service_id),
  ]);

  // Só marcar concluido se todos fecharam E existe pelo menos 1 registo de ponto.
  // O guard .eq("status","em_curso") evita dupla-promoção em corrida paralela.
  if ((openCount ?? 1) === 0 && (totalCount ?? 0) > 0) {
    await admin.from("services")
      .update({ actual_end: clockOutAt, status: "concluido" })
      .eq("id", service_id)
      .eq("status", "em_curso");
  }

  return NextResponse.json({ data: updatedTs, duration_minutes, tooOld });
}

// TASK 08 — instrumentação leve (duração + status), sem dados sensíveis.
export const POST = withRouteMetrics("/api/app/timesheet", postHandler);
export const PATCH = withRouteMetrics("/api/app/timesheet", patchHandler);
