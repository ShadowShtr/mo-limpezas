import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { service_id, lat, lng } = await req.json();
  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });

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
    .select("location_lat, location_lng")
    .eq("id", service_id)
    .single();

  let distance_m: number | null = null;
  let location_warning = false;

  if (lat && lng && service?.location_lat && service?.location_lng) {
    distance_m = Math.round(
      haversine(lat, lng, Number(service.location_lat), Number(service.location_lng))
    );
    location_warning = distance_m > 300;
  }

  const insertPayload = {
    service_id,
    collaborator_id: user.id,
    company_id: profile.company_id,
    clock_in_at: new Date().toISOString(),
    clock_in_lat: lat ?? null,
    clock_in_lng: lng ?? null,
    clock_in_distance_m: distance_m,
    location_warning,
  };

  const { data, error } = await admin
    .from("timesheets")
    .insert(insertPayload)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data, distance_m, location_warning });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { service_id, lat, lng } = await req.json();
  if (!service_id)
    return NextResponse.json({ error: "service_id required" }, { status: 400 });

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
      clock_out_lat: lat ?? null,
      clock_out_lng: lng ?? null,
      duration_minutes,
    })
    .eq("id", ts.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data, duration_minutes });
}
