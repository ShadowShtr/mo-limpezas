import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanySettings } from "@/app/actions/settings";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { haversineDistanceM } from "@/lib/calculations";

function parseCoord(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Valida um timestamp do cliente (registo offline). Devolve ISO no passado, ou agora. */
function parsePastTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t <= Date.now() + 60_000) {
      return new Date(t).toISOString();
    }
  }
  return new Date().toISOString();
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("timesheet", user.id), 10, 60_000);
  if (limited) return limited;

  const { service_id, lat: rawLat, lng: rawLng, clock_in_at: rawClockIn, manual } = await req.json();
  const lat = parseCoord(rawLat);
  const lng = parseCoord(rawLng);
  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });
  // GPS obrigatório apenas se não for check-in manual confirmado
  if ((lat == null || lng == null) && !manual) {
    return NextResponse.json(
      { error: "Ative a localização/GPS para registar o ponto.", needsManualConfirm: true },
      { status: 400 }
    );
  }

  // Hora do clock-in: aceitar a do cliente (registo offline em fila), nunca no futuro.
  const clockInAt = parsePastTimestamp(rawClockIn);

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (!profile)
    return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  const { data: service } = await admin
    .from("services_full")
    .select("id, company_id, team_id, location_lat, location_lng, scheduled_start, scheduled_end")
    .eq("id", service_id)
    .eq("company_id", profile.company_id)
    .single();

  if (!service)
    return NextResponse.json({ error: "Serviço não encontrado" }, { status: 404 });

  const [{ data: membership }, { data: reinforcement }, settings] = await Promise.all([
    service.team_id
      ? admin
          .from("team_members")
          .select("id")
          .eq("team_id", service.team_id)
          .eq("collaborator_id", user.id)
          .is("left_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("service_reinforcements")
      .select("id")
      .eq("service_id", service_id)
      .eq("collaborator_id", user.id)
      .maybeSingle(),
    getCompanySettings(profile.company_id),
  ]);

  if (!membership && !reinforcement) {
    return NextResponse.json({ error: "Sem permissão para este serviço" }, { status: 403 });
  }

  // Validar janela horária do clock-in (usa a hora real do registo — importante p/ fila offline)
  if (service.scheduled_start) {
    const ref = new Date(clockInAt);
    const scheduledStart = new Date(service.scheduled_start);
    const earliestClockIn = new Date(scheduledStart.getTime() - settings.checkin_before_minutes * 60_000);
    if (ref < earliestClockIn) {
      const diffMin = Math.round((earliestClockIn.getTime() - ref.getTime()) / 60_000);
      return NextResponse.json(
        { error: `Ainda não pode iniciar o serviço. Pode fazer clock-in em ${diffMin} minuto${diffMin !== 1 ? "s" : ""}.` },
        { status: 400 },
      );
    }
  }

  let distance_m: number | null = null;
  let location_warning = false;

  if (lat != null && lng != null && service.location_lat != null && service.location_lng != null) {
    distance_m = Math.round(
      haversineDistanceM(lat, lng, Number(service.location_lat), Number(service.location_lng))
    );
    location_warning = distance_m > settings.gps_radius_meters;
  }

  // Guard: ponto aberto para este serviço (double clock-in)
  const { data: dupOpen } = await admin
    .from("timesheets")
    .select("id")
    .eq("service_id", service_id)
    .eq("collaborator_id", user.id)
    .is("clock_out_at", null)
    .maybeSingle();

  if (dupOpen) {
    return NextResponse.json(
      { error: "Já tem um ponto aberto para este serviço. Registe a saída primeiro." },
      { status: 409 }
    );
  }

  // Guard: ponto aberto noutro serviço (entrada sem saída anterior)
  const { data: openElsewhere } = await admin
    .from("timesheets")
    .select("id")
    .eq("collaborator_id", user.id)
    .is("clock_out_at", null)
    .neq("service_id", service_id)
    .maybeSingle();

  if (openElsewhere) {
    return NextResponse.json(
      { error: "Tem um ponto aberto noutro serviço. Registe a saída nesse serviço antes de iniciar um novo." },
      { status: 409 }
    );
  }

  const insertPayload = {
    service_id,
    collaborator_id: user.id,
    company_id: profile.company_id,
    clock_in_at: clockInAt,
    clock_in_lat: lat,
    clock_in_lng: lng,
    clock_in_distance_m: distance_m,
    location_warning: manual ? true : location_warning,
  };

  const { data, error } = await admin
    .from("timesheets")
    .insert(insertPayload)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin
    .from("services")
    .update({ actual_start: insertPayload.clock_in_at, status: "em_curso" })
    .eq("id", service_id)
    .is("actual_start", null);

  return NextResponse.json({ data, distance_m, location_warning });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("timesheet", user.id), 10, 60_000);
  if (limited) return limited;

  const { service_id, lat: rawLat, lng: rawLng, clock_out_at: rawClockOut, manual } = await req.json();
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

  const clockOutAt = parsePastTimestamp(rawClockOut);

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (!profile)
    return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  const [{ data: ts }, { data: service }, settings] = await Promise.all([
    admin
      .from("timesheets")
      .select("id, clock_in_at")
      .eq("service_id", service_id)
      .eq("collaborator_id", user.id)
      .is("clock_out_at", null)
      .single(),
    admin
      .from("services_full")
      .select("scheduled_end")
      .eq("id", service_id)
      .eq("company_id", profile.company_id)
      .single(),
    getCompanySettings(profile.company_id),
  ]);

  if (!ts)
    return NextResponse.json({ error: "Registo de entrada não encontrado" }, { status: 404 });

  // Validar janela de saída: não pode terminar mais de checkout_after_minutes após o fim previsto
  if (service?.scheduled_end) {
    const ref = new Date(clockOutAt);
    const scheduledEnd = new Date(service.scheduled_end);
    const latestClockOut = new Date(scheduledEnd.getTime() + settings.checkout_after_minutes * 60_000);
    if (ref > latestClockOut) {
      const diffMin = Math.round((ref.getTime() - latestClockOut.getTime()) / 60_000);
      return NextResponse.json(
        { error: `O prazo para terminar o ponto já passou há ${diffMin} minuto${diffMin !== 1 ? "s" : ""}. Contacte o gestor para corrigir o registo.` },
        { status: 400 },
      );
    }
  }

  const out = new Date(clockOutAt);
  const duration_minutes = ts.clock_in_at
    ? Math.max(0, Math.round((out.getTime() - new Date(ts.clock_in_at).getTime()) / 60000))
    : 0;

  const { data, error } = await admin
    .from("timesheets")
    .update({
      clock_out_at: clockOutAt,
      clock_out_lat: lat,
      clock_out_lng: lng,
      duration_minutes,
    })
    .eq("id", ts.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const { count } = await admin
    .from("timesheets")
    .select("id", { count: "exact", head: true })
    .eq("service_id", service_id)
    .is("clock_out_at", null);

  if ((count ?? 0) === 0) {
    await admin
      .from("services")
      .update({ actual_end: clockOutAt, status: "concluido" })
      .eq("id", service_id);
  }

  return NextResponse.json({ data, duration_minutes });
}
