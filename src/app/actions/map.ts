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

export interface MapTeam {
  id: string;
  name: string;
  color: string;
}

export async function getMapServices(date: string): Promise<{ services: MapService[]; teams: MapTeam[] }> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { services: [], teams: [] };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (!profile?.company_id) return { services: [], teams: [] };

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

  return {
    services: mapped,
    teams: (teams ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}
