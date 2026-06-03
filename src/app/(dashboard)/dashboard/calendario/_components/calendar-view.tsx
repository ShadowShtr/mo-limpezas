"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks,
  subWeeks,
  addDays,
  isSameDay,
  parseISO,
  format,
} from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar, Plus } from "lucide-react";
import { ServiceBlock, type ServiceForBlock } from "./service-block";
import { ServiceCreateSheet } from "./service-create-sheet";
import { ServiceDetailSheet } from "./service-detail-sheet";
import type { Database } from "@/types/database";

// ─── Constantes do grid ───────────────────────────────────────────────────────

const START_HOUR = 7;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const SLOT_HEIGHT = 36; // px por 30 min
const SLOTS_PER_HOUR = 2;
const TOTAL_SLOTS = TOTAL_HOURS * SLOTS_PER_HOUR; // 30

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team = { id: string; name: string; color: string };
type Client = { id: string; name: string };
type Location = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };

// ─── Tipos de props ───────────────────────────────────────────────────────────

interface CalendarViewProps {
  services: ServiceFull[];
  teams: Team[];
  weekStartISO: string;
  selectedDateISO: string;
  companyId: string;
  userId: string;
  clients: Client[];
  locations: Location[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toServiceBlock(s: ServiceFull): ServiceForBlock {
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
  };
}

function yToTime(y: number): string {
  const slotIndex = Math.floor(y / SLOT_HEIGHT);
  const clampedSlot = Math.max(0, Math.min(slotIndex, TOTAL_SLOTS - 1));
  const totalMin = START_HOUR * 60 + clampedSlot * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getCurrentTimeTop(selectedDate: Date): number | null {
  const now = new Date();
  if (!isSameDay(selectedDate, now)) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = START_HOUR * 60;
  const endMin = END_HOUR * 60;
  if (nowMin < startMin || nowMin > endMin) return null;
  return ((nowMin - startMin) / 30) * SLOT_HEIGHT;
}

const DAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

// ─── Componente principal ─────────────────────────────────────────────────────

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

  const [selectedDate, setSelectedDate] = useState(() => parseISO(selectedDateISO));

  // Sheet de criação
  const [createSheet, setCreateSheet] = useState<{
    teamId: string;
    startTime: string;
  } | null>(null);

  // Sheet de detalhe
  const [detailService, setDetailService] = useState<ServiceFull | null>(null);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const dayServices = useMemo(
    () => services.filter((s) => isSameDay(parseISO(s.scheduled_start), selectedDate)),
    [services, selectedDate],
  );

  const servicesByTeam = useMemo(() => {
    const map: Record<string, ServiceForBlock[]> = {};
    teams.forEach((t) => { map[t.id] = []; });
    map["__sem_equipa__"] = [];
    dayServices.forEach((s) => {
      const key = s.team_id ?? "__sem_equipa__";
      if (!map[key]) map[key] = [];
      map[key].push(toServiceBlock(s));
    });
    return map;
  }, [dayServices, teams]);

  const columns: Array<Team & { key: string }> = useMemo(() => {
    const base = teams.map((t) => ({ ...t, key: t.id }));
    if (servicesByTeam["__sem_equipa__"]?.length > 0) {
      base.push({
        id: "__sem_equipa__",
        name: "Sem equipa",
        color: "#94A3B8",
        key: "__sem_equipa__",
      });
    }
    return base;
  }, [teams, servicesByTeam]);

  const timeTop = useMemo(
    () => getCurrentTimeTop(selectedDate),
    [selectedDate],
  );

  // ─── Navegação semanal ────────────────────────────────────────────────────

  const navigateWeek = useCallback(
    (dir: 1 | -1) => {
      const fn = dir === 1 ? addWeeks : subWeeks;
      const newDate = fn(selectedDate, 1);
      setSelectedDate(newDate);
      router.push(`/dashboard/calendario?date=${format(newDate, "yyyy-MM-dd")}`);
    },
    [selectedDate, router],
  );

  const goToToday = useCallback(() => {
    const today = new Date();
    setSelectedDate(today);
    router.push("/dashboard/calendario");
  }, [router]);

  // ─── Clique na célula do grid (área vazia) ────────────────────────────────

  function handleCellClick(teamId: string, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const startTime = yToTime(y);
    setCreateSheet({ teamId: teamId === "__sem_equipa__" ? "" : teamId, startTime });
  }

  // ─── Clique no bloco de serviço ───────────────────────────────────────────

  function handleServiceClick(service: ServiceForBlock) {
    const full = services.find((s) => s.id === service.id) ?? null;
    setDetailService(full);
  }

  // ─── Refresh após mutação ─────────────────────────────────────────────────

  function handleChanged() {
    router.refresh();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

        {/* Barra de navegação semanal */}
        <div className="flex items-center gap-2 px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0">
          <button
            onClick={() => navigateWeek(-1)}
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            title="Semana anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex gap-1">
            {weekDays.map((day, i) => {
              const isSelected = isSameDay(day, selectedDate);
              const isToday = isSameDay(day, new Date());
              const count = services.filter((s) =>
                isSameDay(parseISO(s.scheduled_start), day),
              ).length;
              return (
                <button
                  key={day.toISOString()}
                  onClick={() => setSelectedDate(day)}
                  className={`flex flex-col items-center px-3 py-1.5 rounded-lg transition-colors min-w-[52px] ${
                    isSelected
                      ? "bg-[var(--color-primary)] text-white"
                      : isToday
                      ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                      : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                  }`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide">{DAY_LABELS[i]}</span>
                  <span className="text-base font-bold leading-tight">{format(day, "d")}</span>
                  {count > 0 ? (
                    <span className={`text-[10px] font-semibold mt-0.5 ${isSelected ? "text-white/80" : "text-[var(--color-text-muted)]"}`}>
                      {count}
                    </span>
                  ) : (
                    <span className="text-[10px] mt-0.5 opacity-0">0</span>
                  )}
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
            onClick={goToToday}
            className="ml-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Hoje
          </button>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm font-medium text-[var(--color-text-main)]">
              {format(selectedDate, "EEEE, d 'de' MMMM yyyy", { locale: pt })}
            </span>
            <button
              onClick={() => setCreateSheet({ teamId: teams[0]?.id ?? "", startTime: "09:00" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo serviço
            </button>
          </div>
        </div>

        {/* Grid do calendário */}
        {columns.length === 0 ? (
          <EmptyTeams />
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Cabeçalho das equipas */}
            <div className="flex bg-white border-b border-[var(--color-border)] shrink-0">
              <div className="w-16 shrink-0 border-r border-[var(--color-border)]" />
              {columns.map((col) => (
                <div
                  key={col.key}
                  className="flex-1 min-w-[180px] px-3 py-2.5 border-l border-[var(--color-border)]"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: col.color }}
                    />
                    <span className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                      {col.name}
                    </span>
                    <span className="ml-auto text-xs text-[var(--color-text-muted)] font-medium tabular-nums">
                      {servicesByTeam[col.id]?.length ?? 0}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Grid com scroll vertical */}
            <div className="flex-1 overflow-auto">
              <div
                className="flex"
                style={{
                  height: `${TOTAL_SLOTS * SLOT_HEIGHT}px`,
                  minWidth: `${64 + columns.length * 180}px`,
                }}
              >
                {/* Coluna de horas */}
                <div className="w-16 shrink-0 border-r border-[var(--color-border)] relative bg-white">
                  {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
                    const hour = START_HOUR + i;
                    return (
                      <div
                        key={hour}
                        className="absolute right-2 text-[11px] text-[var(--color-text-muted)] select-none"
                        style={{
                          top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px`,
                          transform: "translateY(-50%)",
                        }}
                      >
                        {String(hour).padStart(2, "0")}:00
                      </div>
                    );
                  })}
                </div>

                {/* Colunas das equipas */}
                {columns.map((col) => (
                  <div
                    key={col.key}
                    className="flex-1 min-w-[180px] relative border-l border-[var(--color-border)] cursor-crosshair"
                    style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                    onClick={(e) => handleCellClick(col.key, e)}
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
                          opacity: 0.5,
                        }}
                      />
                    ))}

                    {/* Indicador de hora atual */}
                    {timeTop !== null && (
                      <div
                        className="absolute left-0 right-0 z-20 pointer-events-none"
                        style={{ top: `${timeTop}px` }}
                      >
                        <div className="w-full h-0.5 bg-red-500" />
                        <div className="absolute -left-1.5 -top-1.5 w-3 h-3 rounded-full bg-red-500" />
                      </div>
                    )}

                    {/* Blocos de serviço */}
                    {(servicesByTeam[col.id] ?? []).map((service) => (
                      <ServiceBlock
                        key={service.id}
                        service={service}
                        slotHeight={SLOT_HEIGHT}
                        startHour={START_HOUR}
                        onClick={handleServiceClick}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sheet de criação */}
      <ServiceCreateSheet
        open={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        onCreated={handleChanged}
        companyId={companyId}
        userId={userId}
        date={selectedDate}
        initialStartTime={createSheet?.startTime ?? "09:00"}
        initialTeamId={createSheet?.teamId ?? ""}
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
          <a href="/dashboard/equipas" className="text-[var(--color-primary)] hover:underline">
            Equipas
          </a>{" "}
          para começar a agendar serviços.
        </p>
      </div>
    </div>
  );
}
