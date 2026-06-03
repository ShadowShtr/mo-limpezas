"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks,
  subWeeks,
  addDays,
  isSameDay,
  parseISO,
  format,
  endOfWeek,
} from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { ServiceBlock, type ServiceForBlock } from "./service-block";
import { ServiceCreateSheet } from "./service-create-sheet";
import { ServiceDetailSheet } from "./service-detail-sheet";
import type { Database } from "@/types/database";

// ─── Constantes ───────────────────────────────────────────────────────────────

const START_HOUR = 7;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR; // 15
const SLOT_HEIGHT = 40; // px por 30 min
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
    client_name: s.client_name,
    calculated_value: s.calculated_value,
    manual_value: s.manual_value,
    notes: s.notes,
    team_color: s.team_color ?? null,
    team_name: s.team_name ?? null,
  };
}

function yToTime(y: number): string {
  const slot = Math.max(0, Math.min(Math.floor(y / SLOT_HEIGHT), TOTAL_SLOTS - 1));
  const totalMin = START_HOUR * 60 + slot * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function nowTop(): number | null {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = START_HOUR * 60;
  if (nowMin < startMin || nowMin > END_HOUR * 60) return null;
  return ((nowMin - startMin) / 30) * SLOT_HEIGHT;
}

const WEEK_DAYS_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

// ─── Componente ───────────────────────────────────────────────────────────────

export function CalendarView({
  services,
  teams,
  weekStartISO,
  selectedDateISO,
  companyId,
  userId,
  clients,
  locations,
}: CalendarViewProps) {
  const router = useRouter();
  const weekStart = parseISO(weekStartISO);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Semana actual (navegar muda o URL → re-render do server component)
  // weekStart vem do URL; não precisamos de state local para a semana

  const [createSheet, setCreateSheet] = useState<{ date: Date; startTime: string } | null>(null);
  const [detailService, setDetailService] = useState<ServiceFull | null>(null);
  const [currentTop, setCurrentTop] = useState<number | null>(() => nowTop());

  // Actualiza a linha de hora actual a cada minuto
  useEffect(() => {
    const tick = () => setCurrentTop(nowTop());
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  // Scroll automático para a hora actual (ou 08:00) ao montar
  useEffect(() => {
    if (!scrollRef.current) return;
    const target = currentTop !== null
      ? Math.max(0, currentTop - 80)
      : (1 * SLOTS_PER_HOUR * SLOT_HEIGHT); // 08:00
    scrollRef.current.scrollTop = target;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Agrupar serviços por dia
  const byDay = useMemo(() => {
    const map: Record<string, ServiceFull[]> = {};
    weekDays.forEach((d) => { map[d.toISOString()] = []; });
    services.forEach((s) => {
      const day = weekDays.find((d) => isSameDay(d, parseISO(s.scheduled_start)));
      if (day) map[day.toISOString()].push(s);
    });
    return map;
  }, [services, weekDays]);

  // Navegar semana
  const navigateWeek = useCallback(
    (dir: 1 | -1) => {
      const fn = dir === 1 ? addWeeks : subWeeks;
      const newDate = fn(parseISO(selectedDateISO), 1);
      router.push(`/dashboard/calendario?date=${format(newDate, "yyyy-MM-dd")}`);
    },
    [selectedDateISO, router],
  );

  const goToToday = useCallback(() => {
    router.push("/dashboard/calendario");
  }, [router]);

  // Clique na coluna de um dia (célula vazia)
  function handleColumnClick(day: Date, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setCreateSheet({ date: day, startTime: yToTime(y) });
  }

  function handleChanged() {
    router.refresh();
  }

  const today = new Date();
  const weekRange = `${format(weekStart, "d 'de' MMM", { locale: pt })} – ${format(endOfWeek(weekStart, { weekStartsOn: 1 }), "d 'de' MMM yyyy", { locale: pt })}`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

        {/* ── Barra de navegação ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0">
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigateWeek(-1)}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              title="Semana anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigateWeek(1)}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              title="Próxima semana"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Hoje
          </button>

          <span className="text-sm font-semibold text-[var(--color-text-main)]">
            {weekRange}
          </span>

          <div className="ml-auto flex items-center gap-3">
            {/* Legenda de equipas */}
            {teams.length > 0 && (
              <div className="hidden lg:flex items-center gap-3">
                {teams.map((t) => (
                  <div key={t.id} className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="text-xs text-[var(--color-text-muted)]">{t.name}</span>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setCreateSheet({ date: today, startTime: "09:00" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo serviço
            </button>
          </div>
        </div>

        {/* ── Grid do calendário ─────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

          {/* Cabeçalho dos dias (sticky) */}
          <div className="flex bg-white border-b border-[var(--color-border)] shrink-0 z-10">
            {/* Espaço da coluna de horas */}
            <div className="w-14 shrink-0 border-r border-[var(--color-border)]" />

            {weekDays.map((day, i) => {
              const isToday = isSameDay(day, today);
              const count = byDay[day.toISOString()]?.length ?? 0;
              return (
                <div
                  key={day.toISOString()}
                  className={`flex-1 min-w-[100px] flex flex-col items-center justify-center py-2 border-l border-[var(--color-border)] ${
                    isToday ? "bg-[var(--color-primary-light)]" : ""
                  }`}
                >
                  <span className={`text-[10px] font-medium uppercase tracking-wide ${isToday ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
                    {WEEK_DAYS_PT[i]}
                  </span>
                  <div
                    className={`w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold mt-0.5 ${
                      isToday
                        ? "bg-[var(--color-primary)] text-white"
                        : "text-[var(--color-text-main)]"
                    }`}
                  >
                    {format(day, "d")}
                  </div>
                  {count > 0 ? (
                    <span className={`text-[10px] mt-0.5 font-medium ${isToday ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
                      {count} serv.
                    </span>
                  ) : (
                    <span className="text-[10px] mt-0.5 opacity-0">0</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Área de scroll do grid */}
          <div ref={scrollRef} className="flex-1 overflow-auto">
            <div
              className="flex"
              style={{
                height: `${TOTAL_SLOTS * SLOT_HEIGHT}px`,
                minWidth: `${56 + 7 * 100}px`,
              }}
            >
              {/* Coluna de horas */}
              <div className="w-14 shrink-0 border-r border-[var(--color-border)] relative bg-white">
                {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
                  const hour = START_HOUR + i;
                  return (
                    <div
                      key={hour}
                      className="absolute right-2 select-none"
                      style={{
                        top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px`,
                        transform: "translateY(-50%)",
                      }}
                    >
                      <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
                        {String(hour).padStart(2, "0")}:00
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Colunas dos dias */}
              {weekDays.map((day) => {
                const isToday = isSameDay(day, today);
                const dayServices = byDay[day.toISOString()] ?? [];

                return (
                  <div
                    key={day.toISOString()}
                    className={`flex-1 min-w-[100px] relative border-l border-[var(--color-border)] cursor-crosshair ${
                      isToday ? "bg-[var(--color-primary-light)]/20" : ""
                    }`}
                    style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                    onClick={(e) => handleColumnClick(day, e)}
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

                    {/* Linha de hora actual (só hoje) */}
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
                    {dayServices.map((s) => (
                      <ServiceBlock
                        key={s.id}
                        service={toBlock(s)}
                        slotHeight={SLOT_HEIGHT}
                        startHour={START_HOUR}
                        onClick={(b) => {
                          const full = services.find((sv) => sv.id === b.id) ?? null;
                          setDetailService(full);
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Sheet de criação */}
      <ServiceCreateSheet
        open={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        onCreated={handleChanged}
        companyId={companyId}
        userId={userId}
        date={createSheet?.date ?? today}
        initialStartTime={createSheet?.startTime ?? "09:00"}
        initialTeamId=""
        clients={clients}
        locations={locations}
        teams={teams}
      />

      {/* Sheet de detalhe */}
      <ServiceDetailSheet
        service={detailService}
        onClose={() => setDetailService(null)}
        onChanged={handleChanged}
      />
    </>
  );
}
