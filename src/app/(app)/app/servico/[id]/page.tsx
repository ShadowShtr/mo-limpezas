import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ArrowLeft, MapPin, Clock, Key, FileText, Navigation } from "lucide-react";
import { formatTime, formatDate } from "@/lib/utils";
import { StatusBadge } from "../../_components/status-badge";
import { ClockButton } from "./_components/clock-button";
import { TeamRealtime } from "./_components/team-realtime";
import { getCurrentUser } from "@/lib/auth/current-user";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ServicoDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { data: s } = await supabase
    .from("services_full")
    .select(`
      id, scheduled_start, scheduled_end, actual_start, actual_end,
      status, notes, team_id,
      client_name, client_id,
      location_name, location_address, location_lat, location_lng,
      location_access_code, location_instructions, location_has_key, location_key_label,
      team_name, team_color
    `)
    .eq("id", id)
    .single();

  if (!s) notFound();

  const admin = createAdminClient();

  type TimesheetRow = {
    id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    location_warning: boolean | null;
    clock_in_distance_m: number | null;
  };

  // Timesheet do utilizador atual para este serviço
  const { data: myTimesheetRaw } = await admin
    .from("timesheets")
    .select("id, clock_in_at, clock_out_at, location_warning, clock_in_distance_m")
    .eq("service_id", id)
    .eq("collaborator_id", user.id)
    .maybeSingle();

  const myTimesheet = myTimesheetRaw as unknown as TimesheetRow | null;

  type MemberRow = { id: string; full_name: string };

  // Membros da equipa com os seus timesheets
  const { data: membershipsRaw } = s.team_id
    ? await admin
        .from("team_members")
        .select("collaborator_id, profiles(id, full_name)")
        .eq("team_id", s.team_id)
        .is("left_at", null)
    : { data: [] };

  const memberships = (membershipsRaw ?? []) as unknown as {
    collaborator_id: string;
    profiles: MemberRow | null;
  }[];

  const memberIds = memberships
    .map((m) => m.profiles?.id)
    .filter(Boolean) as string[];

  const { data: teamTimesheetsRaw } = memberIds.length
    ? await admin
        .from("timesheets")
        .select("collaborator_id, clock_in_at, clock_out_at")
        .eq("service_id", id)
        .in("collaborator_id", memberIds)
    : { data: [] };

  type TeamTs = { collaborator_id: string; clock_in_at: string | null; clock_out_at: string | null };
  const teamTimesheets = (teamTimesheetsRaw ?? []) as unknown as TeamTs[];

  const teamMembers = memberships
    .map((m) => {
      const p = m.profiles;
      if (!p) return null;
      const ts = teamTimesheets.find((t) => t.collaborator_id === p.id);
      return {
        id: p.id,
        full_name: p.full_name,
        clockIn: ts?.clock_in_at ?? null,
        clockOut: ts?.clock_out_at ?? null,
      };
    })
    .filter(Boolean) as { id: string; full_name: string; clockIn: string | null; clockOut: string | null }[];

  const mapsUrl =
    s.location_lat && s.location_lng
      ? `https://www.google.com/maps/dir/?api=1&destination=${s.location_lat},${s.location_lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          s.location_address ?? s.location_name
        )}`;

  const dateLabel = formatDate(s.scheduled_start);

  return (
    <div className="flex flex-col gap-4 pb-2">

      {/* Voltar */}
      <div className="flex items-center gap-2">
        <Link
          href="/app"
          className="p-1.5 rounded-lg hover:bg-[var(--color-border)] transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-[var(--color-text-sub)]" />
        </Link>
        <span className="text-sm text-[var(--color-text-sub)]">Hoje</span>
      </div>

      {/* Card principal */}
      <div className="bg-white rounded-2xl border border-[var(--color-border)] overflow-hidden">
        <div
          className="h-1.5"
          style={{ backgroundColor: s.team_color ?? "var(--color-primary)" }}
        />

        <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-[var(--color-text-main)]">{s.client_name}</h1>
              <p className="text-sm text-[var(--color-text-sub)]">{s.location_name}</p>
            </div>
            <StatusBadge status={s.status} />
          </div>

          <div className="flex items-center gap-2 text-sm text-[var(--color-text-sub)]">
            <Clock className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
            <span className="capitalize">{dateLabel}</span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="font-medium text-[var(--color-text-main)]">
              {formatTime(s.scheduled_start)} – {formatTime(s.scheduled_end)}
            </span>
          </div>

          {s.location_address && (
            <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
              <MapPin className="w-4 h-4 text-[var(--color-primary)] shrink-0 mt-0.5" />
              <span>{s.location_address}</span>
            </div>
          )}
        </div>
      </div>

      {/* Clock-in / Clock-out */}
      <ClockButton
        serviceId={id}
        initialTimesheet={
          myTimesheet
            ? {
                id: myTimesheet.id,
                clock_in_at: myTimesheet.clock_in_at,
                clock_out_at: myTimesheet.clock_out_at,
                location_warning: myTimesheet.location_warning ?? false,
                clock_in_distance_m: myTimesheet.clock_in_distance_m,
              }
            : null
        }
      />

      {/* Botão Navegar */}
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl bg-[var(--color-primary)] text-white font-semibold text-sm active:bg-[var(--color-primary-hover)] transition-colors"
      >
        <Navigation className="w-4 h-4" />
        Navegar para o local
      </a>

      {/* Painel realtime da equipa */}
      {teamMembers.length > 0 && (
        <TeamRealtime serviceId={id} initialMembers={teamMembers} />
      )}

      {/* Chave física */}
      {s.location_has_key && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Key className="w-4 h-4 text-[var(--color-primary)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Chave</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] bg-[var(--color-primary-light)] rounded-lg px-3 py-2">
            {s.location_key_label || "A equipa tem chave deste local."}
          </p>
        </div>
      )}

      {/* Código do prédio */}
      {s.location_access_code && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Key className="w-4 h-4 text-[var(--color-warning)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Código de acesso</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] font-mono bg-amber-50 rounded-lg px-3 py-2">
            {s.location_access_code}
          </p>
        </div>
      )}

      {/* Instruções */}
      {s.location_instructions && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-[var(--color-info)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Instruções</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] leading-relaxed">
            {s.location_instructions}
          </p>
        </div>
      )}

      {/* Notas */}
      {s.notes && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Notas</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] leading-relaxed">{s.notes}</p>
        </div>
      )}
    </div>
  );
}
