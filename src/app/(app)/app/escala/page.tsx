import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChevronLeft, ChevronRight, MapPin, Clock } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { StatusBadge } from "../_components/status-badge";
import { getCurrentUser } from "@/lib/auth/current-user";
import { todayInLisbon } from "@/lib/lisbon-time";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function getWeekBounds(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  mon.setHours(0, 0, 0, 0);
  sun.setHours(23, 59, 59, 999);
  return { mon, sun };
}

interface Props {
  searchParams: Promise<{ semana?: string }>;
}

export default async function EscalaPage({ searchParams }: Props) {
  const { semana } = await searchParams;
  const supabase = await createClient();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const baseDate = semana ? new Date(semana) : new Date();
  const { mon, sun } = getWeekBounds(baseDate);

  const prevWeek = new Date(mon); prevWeek.setDate(mon.getDate() - 7);
  const nextWeek = new Date(mon); nextWeek.setDate(mon.getDate() + 7);
  const toDateParam = (d: Date) => d.toISOString().split("T")[0];

  const { data: memberships } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("collaborator_id", user.id)
    .is("left_at", null);

  const teamIds = (memberships ?? []).map((m) => m.team_id);

  const { data: services } = teamIds.length
    ? await supabase
        .from("services_full")
        .select("id, scheduled_start, scheduled_end, status, client_name, location_name, team_color")
        .in("team_id", teamIds)
        .gte("scheduled_start", mon.toISOString())
        .lte("scheduled_start", sun.toISOString())
        .order("scheduled_start")
    : { data: [] };

  const list = services ?? [];

  // Agrupar por dia
  const byDay: Record<string, typeof list> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    byDay[toDateParam(d)] = [];
  }
  for (const s of list) {
    const key = s.scheduled_start.split("T")[0];
    if (byDay[key]) byDay[key].push(s);
  }

  const today = todayInLisbon();
  const isCurrentWeek = today >= toDateParam(mon) && today <= toDateParam(sun);

  return (
    <div className="flex flex-col gap-4 pb-2">

      {/* Cabeçalho com navegação de semana */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">Horário</h1>
        <div className="flex items-center gap-1">
          <Link
            href={`/app/escala?semana=${toDateParam(prevWeek)}`}
            className="p-1.5 rounded-lg hover:bg-[var(--color-border)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-[var(--color-text-sub)]" />
          </Link>
          <span className="text-xs font-medium text-[var(--color-text-sub)] min-w-[90px] text-center">
            {mon.getDate()} {MONTHS[mon.getMonth()]} – {sun.getDate()} {MONTHS[sun.getMonth()]}
          </span>
          <Link
            href={`/app/escala?semana=${toDateParam(nextWeek)}`}
            className="p-1.5 rounded-lg hover:bg-[var(--color-border)] transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-[var(--color-text-sub)]" />
          </Link>
        </div>
      </div>

      {/* Mini-calendário horizontal */}
      <div className="flex gap-1">
        {Object.keys(byDay).map((dateKey) => {
          const d = new Date(dateKey);
          const isToday = dateKey === today;
          const hasServices = byDay[dateKey].length > 0;
          return (
            <div
              key={dateKey}
              className={`flex-1 flex flex-col items-center py-2 rounded-xl transition-colors ${
                isToday
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-white border border-[var(--color-border)] text-[var(--color-text-sub)]"
              }`}
            >
              <span className="text-[10px] font-medium">{WEEKDAYS[d.getDay()]}</span>
              <span className={`text-sm font-bold mt-0.5 ${isToday ? "text-white" : "text-[var(--color-text-main)]"}`}>
                {d.getDate()}
              </span>
              {hasServices && (
                <span className={`w-1.5 h-1.5 rounded-full mt-1 ${isToday ? "bg-white/70" : "bg-[var(--color-primary)]"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Lista por dia */}
      <div className="flex flex-col gap-4">
        {Object.entries(byDay).map(([dateKey, dayServices]) => {
          const d = new Date(dateKey);
          const isToday = dateKey === today;
          const isPast = dateKey < today;

          return (
            <div key={dateKey}>
              {/* Label do dia */}
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-xs font-semibold uppercase tracking-wide ${
                  isToday ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"
                }`}>
                  {isToday ? "Hoje" : WEEKDAYS[d.getDay()]} · {d.getDate()} {MONTHS[d.getMonth()]}
                </span>
                {dayServices.length > 0 && (
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {dayServices.length} {dayServices.length === 1 ? "serviço" : "serviços"}
                  </span>
                )}
              </div>

              {dayServices.length === 0 ? (
                <div className={`rounded-xl border border-dashed border-[var(--color-border)] py-3 px-4 text-center ${isPast ? "opacity-50" : ""}`}>
                  <p className="text-xs text-[var(--color-text-muted)]">Sem serviços</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {dayServices.map((s) => (
                    <Link
                      key={s.id}
                      href={`/app/servico/${s.id}`}
                      className={`bg-white rounded-xl border border-[var(--color-border)] p-3 flex gap-3 items-start active:scale-[0.98] transition-transform ${isPast && s.status !== "em_curso" ? "opacity-60" : ""}`}
                    >
                      <div
                        className="w-1 self-stretch rounded-full shrink-0"
                        style={{ backgroundColor: s.team_color ?? "#E2E8F0" }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                            {s.client_name}
                          </p>
                          <StatusBadge status={s.status} />
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                            <Clock className="w-3 h-3" />
                            {formatTime(s.scheduled_start)} – {formatTime(s.scheduled_end)}
                          </span>
                          <span className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] truncate">
                            <MapPin className="w-3 h-3 shrink-0" />
                            {s.location_name}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!isCurrentWeek && (
        <Link
          href="/app/escala"
          className="text-center text-xs text-[var(--color-primary)] font-medium py-2"
        >
          Voltar à semana atual
        </Link>
      )}
    </div>
  );
}
