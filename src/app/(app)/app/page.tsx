import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MapPin, Clock, ChevronRight, Sun, Moon, Coffee, Users, AlertTriangle, Building2 } from "lucide-react";
import { formatTime, formatDate } from "@/lib/utils";
import { StatusBadge } from "./_components/status-badge";
import { getCurrentProfile } from "@/lib/auth/current-user";

export default async function AppHomePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const user = { id: profile.id };

  const supabase = await createClient();

  // Equipas onde a colaboradora está activa
  const { data: memberships } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("collaborator_id", user.id)
    .is("left_at", null);

  const teamIds = (memberships ?? []).map((m) => m.team_id);

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

  const { data: services } = teamIds.length
    ? await supabase
        .from("services_full")
        .select("id, scheduled_start, scheduled_end, status, client_name, location_name, location_address, team_color")
        .in("team_id", teamIds)
        .gte("scheduled_start", todayStart)
        .lte("scheduled_start", todayEnd)
        .order("scheduled_start")
    : { data: [] };

  const list = services ?? [];

  // Ponto geral de hoje — sem ele, os pontos de serviço ficam bloqueados.
  const todayDateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(today);
  const { data: dayClock } = await supabase
    .from("daily_clocks")
    .select("clock_in_at")
    .eq("collaborator_id", user.id)
    .eq("work_date", todayDateKey)
    .maybeSingle();
  const needsClockIn = !dayClock?.clock_in_at;

  // ── Equipa/viatura de hoje ─────────────────────────────────────────────────
  // Por defeito trabalha com a sua equipa; uma reatribuição do dia tem prioridade.
  const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const { data: dayTeam } = await supabase
    .from("collaborator_ride_assignments")
    .select("team_id")
    .eq("collaborator_id", user.id)
    .eq("date", todayDate)
    .maybeSingle();

  const effTeamId = dayTeam?.team_id ?? teamIds[0] ?? null;
  const movido = Boolean(dayTeam?.team_id);

  let todayTeam: { name: string; vehicle: string | null } | null = null;
  if (effTeamId) {
    const [{ data: teamRow }, { data: alloc }] = await Promise.all([
      supabase.from("teams").select("name").eq("id", effTeamId).maybeSingle(),
      supabase
        .from("vehicle_allocations")
        .select("vehicles(model, plate)")
        .eq("team_id", effTeamId)
        .eq("date", todayDate)
        .maybeSingle(),
    ]);
    const v = alloc?.vehicles
      ? (Array.isArray(alloc.vehicles) ? alloc.vehicles[0] : alloc.vehicles)
      : null;
    if (teamRow?.name) {
      todayTeam = { name: teamRow.name, vehicle: v ? `${v.model} · ${v.plate}` : null };
    }
  }

  // ── Prédios de hoje (coluna independente do calendário, sem horário) ───────
  const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const todayWeekday = WEEKDAY_KEYS[new Date(`${todayDateKey}T12:00:00`).getDay()];

  const { data: buildingCards } = effTeamId
    ? await supabase
        .from("building_cards")
        .select("id, name, address, notes")
        .eq("team_id", effTeamId)
        .eq("weekday", todayWeekday)
        .order("sort_order")
    : { data: [] };

  const todayBuildings = buildingCards ?? [];

  const hour = today.getHours();
  const greeting =
    hour < 12 ? "Bom dia" : hour < 19 ? "Boa tarde" : "Boa noite";
  const GreetIcon = hour < 12 ? Sun : hour < 19 ? Coffee : Moon;

  const done    = list.filter((s) => s.status === "concluido").length;
  const total   = list.length;

  return (
    <div className="flex flex-col gap-5 pb-2">

      {/* Saudação */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[var(--color-text-sub)] text-sm mb-0.5">
            <GreetIcon className="w-4 h-4" />
            <span>{greeting}</span>
          </div>
          <h1 className="text-xl font-bold text-[var(--color-text-main)] leading-tight">
            {profile.full_name.split(" ")[0]}
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5 capitalize">
            {formatDate(today.toISOString())}
          </p>
        </div>

        {/* Progresso do dia */}
        {total > 0 && (
          <div className="text-right">
            <p className="text-2xl font-bold text-[var(--color-primary)]">{done}/{total}</p>
            <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wide">concluídos</p>
          </div>
        )}
      </div>

      {/* Barra de progresso */}
      {total > 0 && (
        <div className="h-1.5 bg-[var(--color-border)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--color-primary)] rounded-full transition-all"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}

      {/* Aviso: falta o ponto geral de início */}
      {needsClockIn && (
        <Link
          href="/app/ponto"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform"
        >
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-800">Bate o ponto de início</p>
            <p className="text-xs text-amber-700">Sem isto não consegues registar ponto nos serviços.</p>
          </div>
          <ChevronRight className="w-4 h-4 text-amber-600 shrink-0" />
        </Link>
      )}

      {/* Equipa/viatura de hoje */}
      {todayTeam && (
        <div className={`rounded-2xl border p-4 flex items-center gap-3 ${
          movido ? "bg-amber-50 border-amber-200" : "bg-white border-[var(--color-border)]"
        }`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            movido ? "bg-amber-100" : "bg-[var(--color-primary-light)]"
          }`}>
            <Users className={`w-5 h-5 ${movido ? "text-amber-600" : "text-[var(--color-primary)]"}`} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wide">
              {movido ? "Hoje trabalhas com" : "A tua equipa hoje"}
            </p>
            <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
              {todayTeam.name}
              {todayTeam.vehicle && (
                <span className="text-[var(--color-text-sub)] font-normal"> · {todayTeam.vehicle}</span>
              )}
            </p>
          </div>
          {movido && (
            <span className="ml-auto text-[10px] font-semibold text-amber-600 bg-white border border-amber-200 rounded-full px-2 py-0.5 shrink-0">
              Alterada
            </span>
          )}
        </div>
      )}

      {/* Lista de serviços */}
      <div>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
          Serviços de hoje
        </h2>

        {list.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[var(--color-border)] p-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-3">
              <Sun className="w-6 h-6 text-[var(--color-primary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--color-text-main)]">Nenhum serviço hoje</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Aproveita o descanso!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {list.map((s) => (
              <Link
                key={s.id}
                href={`/app/servico/${s.id}`}
                className="bg-white rounded-2xl border border-[var(--color-border)] p-4 flex gap-3 items-start active:scale-[0.98] transition-transform"
              >
                {/* Barra colorida lateral */}
                <div
                  className="w-1 self-stretch rounded-full shrink-0 mt-0.5"
                  style={{ backgroundColor: s.team_color ?? "#E2E8F0" }}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                        {s.client_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-sub)] mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{s.location_name}</span>
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>

                  <div className="flex items-center gap-1 mt-2 text-xs text-[var(--color-text-muted)]">
                    <Clock className="w-3 h-3" />
                    <span>{formatTime(s.scheduled_start)} – {formatTime(s.scheduled_end)}</span>
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] mt-1 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Prédios de hoje — sem horário, ordem fixa definida pela gestora */}
      {todayBuildings.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
            Prédios de hoje
          </h2>
          <div className="flex flex-col gap-2">
            {todayBuildings.map((b) => (
              <div
                key={b.id}
                className="bg-white rounded-2xl border border-[var(--color-border)] p-3 flex gap-3 items-start"
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0 mt-0.5">
                  <Building2 className="w-4 h-4 text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">{b.name}</p>
                  {b.address && (
                    <p className="text-xs text-[var(--color-text-sub)] mt-0.5 truncate">{b.address}</p>
                  )}
                  {b.notes && (
                    <p className="text-[11px] text-[var(--color-text-muted)] mt-1 truncate">{b.notes}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
