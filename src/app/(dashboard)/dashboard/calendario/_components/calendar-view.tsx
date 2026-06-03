"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks, subWeeks, addDays,
  isSameDay, parseISO, format,
  endOfWeek,
} from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus, Calendar } from "lucide-react";
import { ServiceBlock, type ServiceForBlock } from "./service-block";
import { ServiceCreateSheet } from "./service-create-sheet";
import { ServiceDetailSheet } from "./service-detail-sheet";
import type { Database } from "@/types/database";

// ─── Constantes ───────────────────────────────────────────────────────────────

const START_HOUR = 7;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR;     // 15
const SLOT_HEIGHT = 40;                         // px por 30 min
const SLOTS_PER_HOUR = 2;
const TOTAL_SLOTS = TOTAL_HOURS * SLOTS_PER_HOUR; // 30

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team   = { id: string; name: string; color: string };
type Client = { id: string; name: string };
type Loc    = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };

interface CalendarViewProps {
  services: ServiceFull[];
  teams: Team[];
  weekStartISO: string;
  selectedDateISO: string;
  companyId: string;
  userId: string;
  clients: Client[];
  locations: Loc[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toBlock(s: ServiceFull): ServiceForBlock {
  return {
    id: s.id,
    reference_number: s.reference_number,
    scheduled_start: s.scheduled_start,
    scheduled_end: s.scheduled_end,
    status: s.status,
    location_name: s.location_name,
    location_address: s.location_address,
    location_access_code: s.location_access_code ?? null,
    location_instructions: s.location_instructions ?? null,
    client_name: s.client_name,
    calculated_value: s.calculated_value,
    manual_value: s.manual_value,
    notes: s.notes,
    team_color: s.team_color ?? null,
    team_name: s.team_name ?? null,
  };
}

/** Posição Y da hora actual para um determinado dia (null se não for hoje ou fora do range). */
function computeTimeTop(date: Date): number | null {
  if (!isSameDay(date, new Date())) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = START_HOUR * 60;
  const endMin = END_HOUR * 60;
  if (nowMin < startMin || nowMin > endMin) return null;
  return ((nowMin - startMin) / 30) * SLOT_HEIGHT;
}

function yToTime(y: number): string {
  const slot = Math.max(0, Math.min(Math.floor(y / SLOT_HEIGHT), TOTAL_SLOTS - 1));
  const totalMin = START_HOUR * 60 + slot * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const DAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

// ─── Componente ───────────────────────────────────────────────────────────────

export function CalendarView({
  services, teams, weekStartISO, selectedDateISO,
  companyId, userId, clients, locations,
}: CalendarViewProps) {
  const router    = useRouter();
  const weekStart = parseISO(weekStartISO);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(() => parseISO(selectedDateISO));
  const [currentTop,   setCurrentTop]   = useState(() => computeTimeTop(parseISO(selectedDateISO)));
  const [createSheet,  setCreateSheet]  = useState<{ date: Date; startTime: string; teamId: string } | null>(null);
  const [detailSvc,    setDetailSvc]    = useState<ServiceFull | null>(null);

  // Sincronizar selectedDate quando o servidor re-renderiza (navegação de semana)
  useEffect(() => {
    const d = parseISO(selectedDateISO);
    setSelectedDate(d);
    setCurrentTop(computeTimeTop(d));
  }, [selectedDateISO]);

  // Actualizar linha de hora actual a cada minuto
  useEffect(() => {
    const tick = () => setCurrentTop(computeTimeTop(selectedDate));
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [selectedDate]);

  // Scroll automático para a hora actual ou para 08:00 ao montar e ao mudar de dia
  useEffect(() => {
    if (!scrollRef.current) return;
    const top = computeTimeTop(selectedDate);
    const scrollTo = top !== null
      ? Math.max(0, top - 100)
      : 1 * SLOTS_PER_HOUR * SLOT_HEIGHT; // 08:00
    scrollRef.current.scrollTop = scrollTo;
  }, [selectedDate]);

  // ── Dados derivados ───────────────────────────────────────────────────────

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Serviços do dia seleccionado, agrupados por equipa
  const dayServices = useMemo(
    () => services.filter((s) => isSameDay(parseISO(s.scheduled_start), selectedDate)),
    [services, selectedDate],
  );

  const byTeam = useMemo(() => {
    const map: Record<string, ServiceForBlock[]> = {};
    teams.forEach((t) => { map[t.id] = []; });
    map["__sem__"] = [];
    dayServices.forEach((s) => {
      const key = s.team_id ?? "__sem__";
      if (!map[key]) map[key] = [];
      map[key].push(toBlock(s));
    });
    return map;
  }, [dayServices, teams]);

  // Colunas visíveis: equipas + "sem equipa" se houver serviços sem atribuição
  const columns = useMemo<Array<Team & { key: string }>>(() => {
    const base = teams.map((t) => ({ ...t, key: t.id }));
    if (byTeam["__sem__"]?.length > 0)
      base.push({ id: "__sem__", name: "Sem equipa", color: "#94A3B8", key: "__sem__" });
    return base;
  }, [teams, byTeam]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const navigateWeek = useCallback(
    (dir: 1 | -1) => {
      const fn = dir === 1 ? addWeeks : subWeeks;
      const newDate = fn(selectedDate, 1);
      router.push(`/dashboard/calendario?date=${format(newDate, "yyyy-MM-dd")}`);
    },
    [selectedDate, router],
  );

  function handleSelectDay(day: Date) {
    setSelectedDate(day);
    setCurrentTop(computeTimeTop(day));
  }

  function handleColumnClick(teamId: string, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setCreateSheet({ date: selectedDate, startTime: yToTime(y), teamId: teamId === "__sem__" ? "" : teamId });
  }

  function handleChanged() { router.refresh(); }

  const today    = new Date();
  const isToday  = isSameDay(selectedDate, today);
  const weekRange = `${format(weekStart, "d MMM", { locale: pt })} – ${format(endOfWeek(weekStart, { weekStartsOn: 1 }), "d MMM yyyy", { locale: pt })}`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

        {/* ── Barra de navegação semanal ─────────────────────────────────── */}
        <div className="flex items-center gap-2 px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0">
          {/* Navegação de semana */}
          <button
            onClick={() => navigateWeek(-1)}
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            title="Semana anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Tabs dos dias */}
          <div className="flex gap-1">
            {weekDays.map((day, i) => {
              const isSel  = isSameDay(day, selectedDate);
              const isTody = isSameDay(day, today);
              const count  = services.filter((s) => isSameDay(parseISO(s.scheduled_start), day)).length;
              return (
                <button
                  key={day.toISOString()}
                  onClick={() => handleSelectDay(day)}
                  className={`flex flex-col items-center px-3 py-1.5 rounded-lg transition-colors min-w-[50px] ${
                    isSel  ? "bg-[var(--color-primary)] text-white"
                    : isTody ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                  }`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide">{DAY_LABELS[i]}</span>
                  <span className="text-sm font-bold leading-tight">{format(day, "d")}</span>
                  <span className={`text-[10px] mt-0.5 font-semibold ${isSel ? "text-white/70" : "text-[var(--color-text-muted)]"} ${count === 0 ? "opacity-0" : ""}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => navigateWeek(1)}
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            title="Próxima semana"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => router.push("/dashboard/calendario")}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Hoje
          </button>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm font-medium text-[var(--color-text-main)] hidden sm:block">
              {format(selectedDate, "EEEE, d 'de' MMMM yyyy", { locale: pt })}
            </span>
            <span className="text-xs text-[var(--color-text-muted)] hidden md:block">{weekRange}</span>
            <button
              onClick={() => setCreateSheet({ date: selectedDate, startTime: "09:00", teamId: teams[0]?.id ?? "" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo serviço
            </button>
          </div>
        </div>

        {/* ── Grid do calendário ─────────────────────────────────────────── */}
        {columns.length === 0 ? (
          <EmptyTeams />
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

            {/* Cabeçalho das equipas (sticky) */}
            <div className="flex bg-white border-b border-[var(--color-border)] shrink-0">
              {/* Espaço da coluna de horas */}
              <div className="w-14 shrink-0 border-r border-[var(--color-border)]" />
              {columns.map((col) => (
                <div
                  key={col.key}
                  className="flex-1 min-w-[160px] px-3 py-2.5 border-l border-[var(--color-border)]"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                    <span className="text-sm font-semibold text-[var(--color-text-main)] truncate">{col.name}</span>
                    <span className="ml-auto text-xs font-medium text-[var(--color-text-muted)] tabular-nums">
                      {byTeam[col.id]?.length ?? 0}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Área de scroll vertical */}
            <div ref={scrollRef} className="flex-1 overflow-auto">
              <div
                className="flex"
                style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px`, minWidth: `${56 + columns.length * 160}px` }}
              >
                {/* Coluna de horas */}
                <div className="w-14 shrink-0 border-r border-[var(--color-border)] relative bg-white">
                  {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
                    const hour = START_HOUR + i;
                    return (
                      <div
                        key={hour}
                        className="absolute right-2 select-none"
                        style={{ top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px`, transform: "translateY(-50%)" }}
                      >
                        <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
                          {String(hour).padStart(2, "0")}:00
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Colunas das equipas */}
                {columns.map((col) => (
                  <div
                    key={col.key}
                    className="flex-1 min-w-[160px] relative border-l border-[var(--color-border)] cursor-crosshair"
                    style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                    onClick={(e) => handleColumnClick(col.key, e)}
                  >
                    {/* Linhas de hora (sólidas) */}
                    {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
                      <div
                        key={`h-${i}`}
                        className="absolute left-0 right-0 border-t border-[var(--color-border)] pointer-events-none"
                        style={{ top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px` }}
                      />
                    ))}
                    {/* Linhas de meia hora (tracejadas) */}
                    {Array.from({ length: TOTAL_HOURS }, (_, i) => (
                      <div
                        key={`hh-${i}`}
                        className="absolute left-0 right-0 pointer-events-none"
                        style={{
                          top: `${(i * SLOTS_PER_HOUR + 1) * SLOT_HEIGHT}px`,
                          borderTop: "1px dashed var(--color-border)",
                          opacity: 0.4,
                        }}
                      />
                    ))}

                    {/* Linha de hora actual */}
                    {isToday && currentTop !== null && (
                      <div
                        className="absolute left-0 right-0 z-20 pointer-events-none"
                        style={{ top: `${currentTop}px` }}
                      >
                        <div className="w-full h-0.5 bg-red-500" />
                        <div className="absolute -left-1 -top-1.5 w-3 h-3 rounded-full bg-red-500" />
                      </div>
                    )}

                    {/* Blocos de serviço */}
                    {(byTeam[col.id] ?? []).map((svc) => (
                      <ServiceBlock
                        key={svc.id}
                        service={svc}
                        slotHeight={SLOT_HEIGHT}
                        startHour={START_HOUR}
                        onClick={(b) => setDetailSvc(services.find((s) => s.id === b.id) ?? null)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sheets */}
      <ServiceCreateSheet
        open={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        onCreated={handleChanged}
        companyId={companyId}
        userId={userId}
        date={createSheet?.date ?? today}
        initialStartTime={createSheet?.startTime ?? "09:00"}
        initialTeamId={createSheet?.teamId ?? ""}
        clients={clients}
        locations={locations}
        teams={teams}
      />
      <ServiceDetailSheet
        service={detailSvc}
        onClose={() => setDetailSvc(null)}
        onChanged={handleChanged}
      />
    </>
  );
}

// ─── Estado vazio ─────────────────────────────────────────────────────────────

function EmptyTeams() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="w-12 h-12 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center">
        <Calendar className="w-6 h-6 text-[var(--color-primary)]" />
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Sem equipas criadas</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          Cria equipas em{" "}
          <a href="/dashboard/equipas" className="text-[var(--color-primary)] hover:underline">Equipas</a>{" "}
          para começar a agendar serviços.
        </p>
      </div>
    </div>
  );
}
