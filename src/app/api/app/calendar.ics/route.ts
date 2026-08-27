import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeIcs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login");

  const admin = createAdminClient();

  const { data: memberships } = await admin
    .from("team_members")
    .select("team_id")
    .eq("collaborator_id", user.id)
    .is("left_at", null);

  const teamIds = (memberships ?? []).map((m) => m.team_id);

  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();

  const { data: services } = teamIds.length
    ? await admin
        .from("services_full")
        .select(
          "id, scheduled_start, scheduled_end, client_name, location_name, location_address, team_name, status"
        )
        .in("team_id", teamIds)
        .gte("scheduled_start", from)
        .lte("scheduled_start", to)
        .neq("status", "cancelado")
        .order("scheduled_start")
    : { data: [] };

  const list = services ?? [];

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mó Limpezas//Escala//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Mó Limpezas — Escala",
    "X-WR-TIMEZONE:Europe/Lisbon",
  ];

  for (const s of list) {
    const summary = escapeIcs(`${s.client_name} — ${s.location_name}`);
    const location = s.location_address ? escapeIcs(s.location_address) : "";
    const description = escapeIcs(`Equipa: ${s.team_name ?? ""}`);

    lines.push(
      "BEGIN:VEVENT",
      `UID:escala-${s.id}@molimpezas.pt`,
      `DTSTART:${icsDate(s.scheduled_start)}`,
      `DTEND:${icsDate(s.scheduled_end)}`,
      `SUMMARY:${summary}`,
      location ? `LOCATION:${location}` : "",
      `DESCRIPTION:${description}`,
      `STATUS:${s.status === "concluido" ? "CONFIRMED" : "TENTATIVE"}`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");

  const ics = lines.filter(Boolean).join("\r\n");

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="escala.ics"',
      "Cache-Control": "no-store",
    },
  });
}
