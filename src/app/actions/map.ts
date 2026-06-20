"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export interface MapService {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  notes: string | null;
  location_id: string;
  location_name: string;
  location_address: string;
  lat: number;
  lng: number;
  client_name: string;
  team_id: string | null;
  team_name: string | null;
  team_color: string | null;
}

export interface MapClockPoint {
  id: string;
  service_id: string;
  collaborator_id: string;
  collaborator_name: string;
  type: "in" | "out";
  at: string;
  lat: number;
  lng: number;
  location_warning: boolean;
  service_status: string;
  client_name: string;
  location_name: string;
  team_id: string | null;
  team_name: string | null;
  team_color: string | null;
}

export interface MapTeam {
  id: string;
  name: string;
  color: string;
}

export async function getMapServices(date: string): Promise<{ services: MapService[]; teams: MapTeam[]; clockPoints: MapClockPoint[] }> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { services: [], teams: [], clockPoints: [] };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile?.company_id) return { services: [], teams: [], clockPoints: [] };
  if (!["admin", "gestor"].includes(profile.role)) return { services: [], teams: [], clockPoints: [] };

  const startOfDay = `${date}T00:00:00.000Z`;
  const endOfDay = `${date}T23:59:59.999Z`;

  const { data: services } = await admin
    .from("services")
    .select(`
      id,
      scheduled_start,
      scheduled_end,
      status,
      notes,
      location_id,
      team_id,
      locations (
        name,
        address,
        lat,
        lng,
        clients ( name )
      ),
      teams (
        name,
        color
      )
    `)
    .eq("company_id", profile.company_id)
    .gte("scheduled_start", startOfDay)
    .lte("scheduled_start", endOfDay)
    .neq("status", "cancelado")
    .order("scheduled_start");

  const { data: teams } = await admin
    .from("teams")
    .select("id, name, color")
    .eq("company_id", profile.company_id)
    .eq("active", true)
    .order("name");

  const mapped: MapService[] = (services ?? [])
    .filter((s) => {
      const loc = (s.locations as unknown) as { lat?: number | null; lng?: number | null } | null;
      return loc?.lat != null && loc?.lng != null;
    })
    .map((s) => {
      const loc = (s.locations as unknown) as {
        name: string;
        address: string;
        lat: number;
        lng: number;
        clients: { name: string } | null;
      };
      const team = (s.teams as unknown) as { name: string; color: string } | null;
      return {
        id: s.id,
        scheduled_start: s.scheduled_start,
        scheduled_end: s.scheduled_end,
        status: s.status,
        notes: s.notes,
        location_id: s.location_id,
        location_name: loc.name,
        location_address: loc.address,
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        client_name: loc.clients?.name ?? "—",
        team_id: s.team_id,
        team_name: team?.name ?? null,
        team_color: team?.color ?? null,
      };
    });

  const serviceMeta = new Map(
    (services ?? []).map((s) => {
      const loc = (s.locations as unknown) as {
        name?: string | null;
        address?: string | null;
        clients?: { name?: string | null } | null;
      } | null;
      const team = (s.teams as unknown) as { name?: string | null; color?: string | null } | null;

      return [
        s.id,
        {
          client_name: loc?.clients?.name ?? "—",
          location_name: loc?.name ?? "Local",
          service_status: s.status,
          team_id: s.team_id,
          team_name: team?.name ?? null,
          team_color: team?.color ?? null,
        },
      ];
    })
  );
  const serviceIds = (services ?? []).map((s) => s.id);

  const { data: timesheets } = serviceIds.length
    ? await admin
        .from("timesheets")
        .select(`
          id,
          service_id,
          collaborator_id,
          clock_in_at,
          clock_in_lat,
          clock_in_lng,
          clock_out_at,
          clock_out_lat,
          clock_out_lng,
          location_warning,
          profiles (
            full_name
          )
        `)
        .eq("company_id", profile.company_id)
        .in("service_id", serviceIds)
    : { data: [] };

  const clockPoints: MapClockPoint[] = [];
  (timesheets ?? []).forEach((ts) => {
    const service = serviceMeta.get(ts.service_id);
    if (!service) return;
    const profileRow = ts.profiles as unknown as { full_name?: string | null } | null;
    const base = {
      service_id: ts.service_id,
      collaborator_id: ts.collaborator_id,
      collaborator_name: profileRow?.full_name ?? "Colaboradora",
      location_warning: Boolean(ts.location_warning),
      client_name: service.client_name,
      location_name: service.location_name,
      service_status: service.service_status,
      team_id: service.team_id,
      team_name: service.team_name,
      team_color: service.team_color,
    };

    const inLat = Number(ts.clock_in_lat);
    const inLng = Number(ts.clock_in_lng);
    if (ts.clock_in_at && Number.isFinite(inLat) && Number.isFinite(inLng)) {
      clockPoints.push({
        ...base,
        id: `${ts.id}-in`,
        type: "in",
        at: ts.clock_in_at,
        lat: inLat,
        lng: inLng,
      });
    }

    const outLat = Number(ts.clock_out_lat);
    const outLng = Number(ts.clock_out_lng);
    if (ts.clock_out_at && Number.isFinite(outLat) && Number.isFinite(outLng)) {
      clockPoints.push({
        ...base,
        id: `${ts.id}-out`,
        type: "out",
        at: ts.clock_out_at,
        lat: outLat,
        lng: outLng,
      });
    }
  });

  return {
    services: mapped,
    clockPoints,
    teams: (teams ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}
