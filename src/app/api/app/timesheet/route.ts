import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanySettings } from "@/app/actions/settings";

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoord(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function gpsError() {
  return NextResponse.json(
    { error: "Ative a localização/GPS para registar o ponto." },
    { status: 400 }
  );
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { service_id, lat: rawLat, lng: rawLng } = await req.json();
  const lat = parseCoord(rawLat);
  const lng = parseCoord(rawLng);
  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });
  if (lat == null || lng == null) return gpsError();

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
    .select("id, company_id, team_id, location_lat, location_lng")
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

  let distance_m: number | null = null;
  let location_warning = false;

  if (service.location_lat != null && service.location_lng != null) {
    distance_m = Math.round(
      haversine(lat, lng, Number(service.location_lat), Number(service.location_lng))
    );
    location_warning = distance_m > settings.gps_radius_meters;
  }

  const insertPayload = {
    service_id,
    collaborator_id: user.id,
    company_id: profile.company_id,
    clock_in_at: new Date().toISOString(),
    clock_in_lat: lat,
    clock_in_lng: lng,
    clock_in_distance_m: distance_m,
    location_warning,
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

  const { service_id, lat: rawLat, lng: rawLng } = await req.json();
  const lat = parseCoord(rawLat);
  const lng = parseCoord(rawLng);
  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });
  if (lat == null || lng == null) return gpsError();

  const admin = createAdminClient();

  const { data: ts } = await admin
    .from("timesheets")
    .select("id, clock_in_at")
    .eq("service_id", service_id)
    .eq("collaborator_id", user.id)
    .is("clock_out_at", null)
    .single();

  if (!ts)
    return NextResponse.json({ error: "Clock-in não encontrado" }, { status: 404 });

  const now = new Date();
  const duration_minutes = ts.clock_in_at
    ? Math.round((now.getTime() - new Date(ts.clock_in_at).getTime()) / 60000)
    : 0;

  const { data, error } = await admin
    .from("timesheets")
    .update({
      clock_out_at: now.toISOString(),
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
      .update({ actual_end: now.toISOString(), status: "concluido" })
      .eq("id", service_id);
  }

  return NextResponse.json({ data, duration_minutes });
}
