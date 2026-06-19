"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks, subWeeks, addDays, addMinutes,
  isSameDay, parseISO, format, differenceInMinutes,
  endOfWeek,
} from "date-fns";
import { pt } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, Plus, AlertTriangle, X,
  Users, LayoutGrid, List, Bell, FileDown, Loader2,
} from "lucide-react";
import {
  DndContext, DragOverlay,
  PointerSensor, useSensor, useSensors,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { ServiceBlock, type ServiceForBlock } from "./service-block";
import { travelMinutes, type TeamRoute } from "./day-pdf";
import { DroppableColumn } from "./droppable-column";
import { ServiceCreateSheet } from "./service-create-sheet";
import { ServiceDetailSheet } from "./service-detail-sheet";
import { TeamAllocationModal } from "./team-allocation-modal";
import { CalendarListView } from "./calendar-list-view";
import { ClientNotificationsModal } from "./client-notifications-modal";
import { rescheduleService, type ConflictInfo } from "../_actions/reschedule";
import type { Database } from "@/types/database";

// ─── Constantes ───────────────────────────────────────────────────────────────

const START_HOUR    = 7;
const END_HOUR      = 22;
const TOTAL_HOURS   = END_HOUR - START_HOUR;
const SLOT_HEIGHT   = 40;
const SLOTS_PER_HOUR = 2;
const TOTAL_SLOTS   = TOTAL_HOURS * SLOTS_PER_HOUR;
const GUTTER_W      = 56;
const HEADER_H      = 44;

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
  clients: Client[];
  locations: Loc[];
  isDemo?: boolean;
}

type PendingForce = {
  serviceId: string;
  newStart: string;
  newEnd: string;
  newTeamId: string | null;
  previous: ServiceFull[];
  title: string;
  message: string;
  conflicts: ConflictInfo[];
};

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
    location_has_key: s.location_has_key ?? false,
    location_key_label: s.location_key_label ?? null,
    location_lat: s.location_lat ?? null,
    location_lng: s.location_lng ?? null,
    client_name: s.client_name,
    calculated_value: s.calculated_value,
    manual_value: s.manual_value,
    notes: s.notes,
    team_color: s.team_color ?? null,
    team_name: s.team_name ?? null,
  };
}

function svcTopPx(svc: ServiceForBlock, startHour: number, slotH: number): number {
  const start = parseISO(svc.scheduled_start);
  return ((start.getHours() * 60 + start.getMinutes() - startHour * 60) / 30) * slotH;
}

function svcBottomPx(svc: ServiceForBlock, startHour: number, slotH: number): number {
  const end = parseISO(svc.scheduled_end);
  return ((end.getHours() * 60 + end.getMinutes() - startHour * 60) / 30) * slotH;
}

function computeTimeTop(date: Date): number | null {
  if (!isSameDay(date, new Date())) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < START_HOUR * 60 || nowMin > END_HOUR * 60) return null;
  return ((nowMin - START_HOUR * 60) / 30) * SLOT_HEIGHT;
}

function yToTime(y: number): string {
  const slot = Math.max(0, Math.min(Math.floor(y / SLOT_HEIGHT), TOTAL_SLOTS - 1));
  const totalMin = START_HOUR * 60 + slot * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const DAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

function GridLines({ totalHours, slotsPerHour, slotHeight }: {
  totalHours: number; slotsPerHour: number; slotHeight: number;
}) {
  return (
    <>
      {Array.from({ length: totalHours + 1 }, (_, i) => (
        <div
          key={`h-${i}`}
          className="absolute left-0 right-0 border-t border-[var(--color-border)] pointer-events-none"
          style={{ top: `${i * slotsPerHour * slotHeight}px` }}
        />
      ))}
      {Array.from({ length: totalHours }, (_, i) => (
        <div
          key={`hh-${i}`}
          className="absolute left-0 right-0 pointer-events-none"
          style={{ top: `${(i * slotsPerHour + 1) * slotHeight}px`, borderTop: "1px dashed var(--color-border)", opacity: 0.4 }}
        />
      ))}
    </>
  );
}

function CurrentTimeLine({ top }: { top: number }) {
  return (
    <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${top}px` }}>
      <div className="w-full h-0.5 bg-red-500" />
      <div className="absolute -left-1 -top-1.5 w-3 h-3 rounded-full bg-red-500" />
    </div>
  );
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function CalendarView({
  services, teams, weekStartISO, selectedDateISO,
  companyId, clients, locations, isDemo = false,
}: CalendarViewProps) {
  const router     = useRouter();
  const weekStart  = parseISO(weekStartISO);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const reasonRef  = useRef<HTMLInputElement>(null);
  const wasDragging = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(() => parseISO(selectedDateISO));
  const [currentTop,   setCurrentTop]   = useState<number | null>(null);
  const [today,        setToday]        = useState<Date | null>(null);
  const [createSheet,    setCreateSheet]    = useState<{ date: Date; startTime: string; teamId: string } | null>(null);
  const [detailSvc,      setDetailSvc]      = useState<ServiceFull | null>(null);
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [avisosOpen,     setAvisosOpen]     = useState(false);
  const [viewMode,       setViewMode]       = useState<"calendar" | "list">("calendar");
  const [localServices,  setLocalServices]  = useState<ServiceFull[]>(services);
  const [draggingBlock,  setDraggingBlock]  = useState<{ service: ServiceForBlock; teamId: string } | null>(null);
  const [conflictMsg,    setConflictMsg]    = useState<string | null>(null);
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [pendingForce,   setPendingForce]   = useState<PendingForce | null>(null);

  // Equipas ocultas persistidas em localStorage por empresa
  const [hiddenTeamIds, setHiddenTeamIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = localStorage.getItem(`cal-hidden-teams-${companyId}`);
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch { return new Set(); }
  });

  const toggleTeam = useCallback((teamId: string) => {
    setHiddenTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
      try { localStorage.setItem(`cal-hidden-teams-${companyId}`, JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  }, [companyId]);

  const showAllTeams = useCallback(() => {
    setHiddenTeamIds(new Set());
    try { localStorage.removeItem(`cal-hidden-teams-${companyId}`); } catch { /* noop */ }
  }, [companyId]);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    setToday(new Date());
    setCurrentTop(computeTimeTop(parseISO(selectedDateISO)));
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    const d = parseISO(selectedDateISO);
    setSelectedDate(d);
    setCurrentTop(computeTimeTop(d));
    setToday(new Date());
  }, [selectedDateISO]);

  useEffect(() => { setLocalServices(services); }, [services]);

  useEffect(() => {
    const id = setInterval(() => setCurrentTop(computeTimeTop(selectedDate)), 60_000);
    return () => clearInterval(id);
  }, [selectedDate]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const top = computeTimeTop(selectedDate);
    scrollRef.current.scrollTop = HEADER_H + (top !== null ? Math.max(0, top - 80) : SLOTS_PER_HOUR * SLOT_HEIGHT);
  }, [selectedDate]);

  // ── Dados derivados ───────────────────────────────────────────────────────

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const dayServices = useMemo(
    () => localServices.filter((s) => isSameDay(parseISO(s.scheduled_start), selectedDate)),
    [localServices, selectedDate],
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
    Object.keys(map).forEach((k) => map[k].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)));
    return map;
  }, [dayServices, teams]);

  // Todas as colunas (equipas + "sem equipa" se houver)
  const columns = useMemo<Array<Team & { key: string }>>(() => {
    const base = teams.map((t) => ({ ...t, key: t.id }));
    if (byTeam["__sem__"]?.length > 0)
      base.push({ id: "__sem__", name: "Sem equipa", color: "#94A3B8", key: "__sem__" });
    return base;
  }, [teams, byTeam]);

  // Colunas visíveis (excluindo as que a gestora ocultou)
  const visibleColumns = useMemo(
    () => columns.filter((col) => !hiddenTeamIds.has(col.id)),
    [columns, hiddenTeamIds],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────

  const navigateWeek = useCallback((dir: 1 | -1) => {
    const fn = dir === 1 ? addWeeks : subWeeks;
    router.push(`/dashboard/calendario?date=${format(fn(selectedDate, 1), "yyyy-MM-dd")}`);
  }, [selectedDate, router]);

  function handleSelectDay(day: Date) {
    setSelectedDate(day);
    setCurrentTop(computeTimeTop(day));
  }

  function handleColumnClick(teamId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (wasDragging.current) { wasDragging.current = false; return; }
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    setCreateSheet({ date: selectedDate, startTime: yToTime(y), teamId: teamId === "__sem__" ? "" : teamId });
  }

  function handleChanged() { router.refresh(); }

  async function handlePdf() {
    setPdfLoading(true);
    try {
      const { generateDayPdf } = await import("./day-pdf");
      const routes: TeamRoute[] = visibleColumns.map((col) => ({
        teamId: col.id, teamName: col.name, teamColor: col.color, services: byTeam[col.id] ?? [],
      }));
      await generateDayPdf(selectedDate, routes);
    } finally { setPdfLoading(false); }
  }

  // ── Force drag handlers ──────────────────────────────────────────────────

  async function handleForceConfirm() {
    if (!pendingForce) return;
    const reason = reasonRef.current?.value?.trim() || "Ajuste operacional validado pela gestora";
    const { serviceId, newStart, newEnd, newTeamId, previous } = pendingForce;
    setPendingForce(null);

    const result = await rescheduleService(serviceId, newStart, newEnd, newTeamId, { force: true, reason });
    if (!result.ok) {
      setLocalServices(previous);
      setConflictMsg(`Erro ao mover: ${result.error}`);
    } else {
      setConflictMsg(result.conflicts.length > 0 ? "Serviço movido com conflito registado." : "Serviço movido.");
    }
  }

  function handleForceCancel() {
    if (!pendingForce) return;
    setLocalServices(pendingForce.previous);
    setPendingForce(null);
    setConflictMsg("Movimento cancelado. Serviço voltou à posição anterior.");
  }

  // ── Drag handlers ────────────────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { service: ServiceForBlock; teamId: string } | undefined;
    if (data) setDraggingBlock(data);
    setConflictMsg(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    wasDragging.current = true;
    setDraggingBlock(null);

    const { active, over, delta } = event;
    if (!over || !active.data.current) return;

    const { service, teamId: fromColKey } = active.data.current as { service: ServiceForBlock; teamId: string };
    const newTeamId   = over.id === "__sem__" ? null : (over.id as string);
    // Converte a column key "sem equipa" para null para comparação correcta
    const origTeamId  = fromColKey === "__sem__" ? null : fromColKey;

    const roundedDelta = Math.round(Math.round((delta.y / SLOT_HEIGHT) * 30) / 15) * 15;

    // Fix: compara com o team_id real (null para "sem equipa") — evita chamada desnecessária ao backend
    if (roundedDelta === 0 && newTeamId === origTeamId) return;

    const origStart  = parseISO(service.scheduled_start);
    const origEnd    = parseISO(service.scheduled_end);
    const duration   = differenceInMinutes(origEnd, origStart);

    let newStart = addMinutes(origStart, roundedDelta);
    let newEnd   = addMinutes(newStart, duration);

    const dayBase = new Date(newStart); dayBase.setHours(START_HOUR, 0, 0, 0);
    const dayEnd  = new Date(newStart); dayEnd.setHours(END_HOUR, 0, 0, 0);
    if (newStart < dayBase) { newStart = dayBase; newEnd = addMinutes(newStart, duration); }
    if (newEnd   > dayEnd)  { newEnd   = dayEnd;  newStart = addMinutes(newEnd, -duration); }

    const previous   = localServices;
    const targetTeam = teams.find((t) => t.id === newTeamId);

    // Atualização otimista
    setLocalServices((curr) => curr.map((s) =>
      s.id === service.id
        ? { ...s, scheduled_start: newStart.toISOString(), scheduled_end: newEnd.toISOString(),
            team_id: newTeamId, team_name: targetTeam?.name ?? null, team_color: targetTeam?.color ?? null }
        : s,
    ));

    const result = await rescheduleService(service.id, newStart.toISOString(), newEnd.toISOString(), newTeamId);

    if (!result.ok && result.canForce) {
      const hasConflicts = (result.conflicts?.length ?? 0) > 0;
      setPendingForce({
        serviceId: service.id,
        newStart: newStart.toISOString(),
        newEnd: newEnd.toISOString(),
        newTeamId,
        previous,
        title: hasConflicts ? "Conflito de horário" : "Serviço em curso",
        message: hasConflicts
          ? `${targetTeam?.name ?? "A equipa destino"} já tem ${result.conflicts!.length === 1 ? "um serviço" : "serviços"} neste horário.`
          : `O serviço está em curso. Confirme que pretende movê-lo${targetTeam ? ` para ${targetTeam.name}` : ""}.`,
        conflicts: result.conflicts ?? [],
      });
      return;
    }

    if (!result.ok) {
      setLocalServices(previous);
      setConflictMsg(`Erro: ${result.error}`);
      return;
    }

    if (result.conflicts.length > 0) {
      setConflictMsg(`Conflito registado (#${result.conflicts.map((c) => c.reference_number).join(", #")}).`);
    } else {
      setConflictMsg(origTeamId !== newTeamId
        ? `Serviço movido para ${targetTeam?.name ?? "outra equipa"}.`
        : "Serviço reagendado.",
      );
    }
  }

  const isToday   = today !== null && isSameDay(selectedDate, today);
  const weekRange = `${format(weekStart, "d MMM", { locale: pt })} – ${format(endOfWeek(weekStart, { weekStartsOn: 1 }), "d MMM yyyy", { locale: pt })}`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

        {/* ── Barra de navegação semanal ─────────────────────────────────── */}
        <div className="flex items-center gap-2 px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0 flex-wrap">
          <button onClick={() => navigateWeek(-1)} title="Semana anterior"
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex gap-1">
            {weekDays.map((day, i) => {
              const isSel  = isSameDay(day, selectedDate);
              const isTody = today !== null && isSameDay(day, today);
              const count  = localServices.filter((s) => isSameDay(parseISO(s.scheduled_start), day)).length;
              return (
                <button key={day.toISOString()} onClick={() => handleSelectDay(day)}
                  className={`flex flex-col items-center px-3 py-1.5 rounded-lg transition-colors min-w-[50px] ${
                    isSel  ? "bg-[var(--color-primary)] text-white"
                    : isTody ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                  <span className="text-[10px] font-medium uppercase tracking-wide">{DAY_LABELS[i]}</span>
                  <span className="text-sm font-bold leading-tight">{format(day, "d")}</span>
                  <span className={`text-[10px] mt-0.5 font-semibold ${isSel ? "text-white/70" : "text-[var(--color-text-muted)]"} ${count === 0 ? "opacity-0" : ""}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <button onClick={() => navigateWeek(1)} title="Próxima semana"
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>

          <button onClick={() => router.push("/dashboard/calendario")}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
            Hoje
          </button>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-text-main)] hidden sm:block">
              {format(selectedDate, "EEEE, d 'de' MMMM yyyy", { locale: pt })}
            </span>
            <span className="text-xs text-[var(--color-text-muted)] hidden md:block mr-1">{weekRange}</span>

            <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              <button onClick={() => setViewMode("calendar")} title="Vista calendário"
                className={`p-1.5 transition-colors ${viewMode === "calendar" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setViewMode("list")} title="Vista lista"
                className={`p-1.5 transition-colors ${viewMode === "list" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                <List className="w-3.5 h-3.5" />
              </button>
            </div>

            <button onClick={handlePdf} disabled={pdfLoading || dayServices.length === 0 || visibleColumns.length === 0}
              title="Exportar plano do dia em PDF"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors disabled:opacity-40">
              {pdfLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
              PDF
            </button>

            <button onClick={() => setAvisosOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors">
              <Bell className="w-3.5 h-3.5" />
              Avisos
            </button>

            <button onClick={() => setAllocationOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors">
              <Users className="w-3.5 h-3.5" />
              Equipas
            </button>

            {isDemo ? (
              <a href="/dashboard/equipas"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors">
                Criar equipas para começar
              </a>
            ) : (
              <button onClick={() => setCreateSheet({ date: selectedDate, startTime: "09:00", teamId: teams[0]?.id ?? "" })}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-3.5 h-3.5" />
                Novo serviço
              </button>
            )}
          </div>
        </div>

        {/* ── Filtro de equipas — só aparece quando há mais de 1 equipa ──── */}
        {columns.length > 1 && (
          <div className="flex items-center gap-2 px-6 py-2 bg-[var(--color-background)] border-b border-[var(--color-border)] shrink-0">
            <span className="text-[11px] font-medium text-[var(--color-text-muted)] shrink-0">Equipas:</span>
            <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
              {columns.map((col) => {
                const hidden = hiddenTeamIds.has(col.id);
                return (
                  <button
                    key={col.key}
                    onClick={() => toggleTeam(col.id)}
                    title={hidden ? `Mostrar ${col.name}` : `Ocultar ${col.name}`}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all select-none ${
                      hidden
                        ? "border-[var(--color-border)] text-[var(--color-text-muted)] bg-white"
                        : "border-transparent text-white"
                    }`}
                    style={!hidden ? { backgroundColor: col.color } : undefined}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full inline-block shrink-0"
                      style={{ backgroundColor: hidden ? col.color : "rgba(255,255,255,0.75)" }}
                    />
                    {col.name}
                  </button>
                );
              })}
              {hiddenTeamIds.size > 0 && (
                <button onClick={showAllTeams}
                  className="text-[11px] text-[var(--color-primary)] hover:underline font-medium ml-1">
                  Mostrar todas
                </button>
              )}
            </div>
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0 tabular-nums">
              {visibleColumns.length}/{columns.length}
            </span>
          </div>
        )}

        {/* Banner de demonstração */}
        {isDemo && (
          <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
            <span className="text-xs font-medium text-amber-700">
              Modo de demonstração — dados de exemplo para visualização. Aplica as migrations e cria equipas para começar a usar.
            </span>
            <a href="/dashboard/equipas" className="text-xs font-semibold text-amber-800 underline ml-auto shrink-0">
              Criar equipas →
            </a>
          </div>
        )}

        {/* Banner de feedback após drag */}
        {conflictMsg && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-xs font-medium text-amber-700 flex-1">{conflictMsg}</span>
            <button onClick={() => setConflictMsg(null)} className="p-0.5 text-amber-500 hover:text-amber-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Vista Lista ────────────────────────────────────────────────── */}
        {viewMode === "list" && (
          <CalendarListView
            services={localServices}
            teams={teams}
            selectedDate={selectedDate}
            onChanged={handleChanged}
          />
        )}

        {/* ── Grid do calendário ─────────────────────────────────────────── */}
        {viewMode === "calendar" && (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Scroll apenas vertical — colunas preenchem a largura total sem barra horizontal */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden calendar-scroll">
              <div style={{ minHeight: `${HEADER_H + TOTAL_SLOTS * SLOT_HEIGHT}px` }}>

                {/* ── Cabeçalho das equipas — sticky no topo ─────────────────── */}
                <div className="flex sticky top-0 z-30 bg-white border-b border-[var(--color-border)] shadow-sm"
                  style={{ height: `${HEADER_H}px` }}>
                  {/* Célula de canto */}
                  <div className="shrink-0 border-r border-[var(--color-border)] bg-white" style={{ width: `${GUTTER_W}px` }} />

                  {visibleColumns.length > 0 ? visibleColumns.map((col) => (
                    <div key={col.key}
                      className="flex-1 min-w-0 relative px-2 flex items-center border-l border-[var(--color-border)] bg-white overflow-hidden">
                      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ backgroundColor: col.color }} />
                      <div className="flex items-center gap-1.5 w-full min-w-0">
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                        <span className="text-xs font-semibold text-[var(--color-text-main)] truncate">{col.name}</span>
                        <span className="ml-auto text-[10px] font-semibold text-[var(--color-text-sub)] tabular-nums bg-[var(--color-background)] rounded-full px-1.5 py-0.5 shrink-0">
                          {byTeam[col.id]?.length ?? 0}
                        </span>
                      </div>
                    </div>
                  )) : (
                    <div className="flex-1 px-4 border-l border-[var(--color-border)] flex items-center gap-2 bg-white">
                      {columns.length === 0 ? (
                        <>
                          <span className="text-sm text-[var(--color-text-muted)]">Sem equipas —</span>
                          <a href="/dashboard/equipas" className="text-sm text-[var(--color-primary)] hover:underline font-medium">Criar equipas</a>
                        </>
                      ) : (
                        <>
                          <span className="text-sm text-[var(--color-text-muted)]">Todas as equipas estão ocultas —</span>
                          <button onClick={showAllTeams} className="text-sm text-[var(--color-primary)] hover:underline font-medium">Mostrar todas</button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Corpo da grelha ────────────────────────────────────────── */}
                <div className="flex" style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}>

                  {/* Coluna de horas */}
                  <div className="shrink-0 sticky left-0 z-20 border-r border-[var(--color-border)] relative bg-white"
                    style={{ width: `${GUTTER_W}px` }}>
                    {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
                      const hour = START_HOUR + i;
                      const transform = i === 0 ? "translateY(2px)" : i === TOTAL_HOURS ? "translateY(-100%)" : "translateY(-50%)";
                      return (
                        <div key={hour} className="absolute right-2 select-none"
                          style={{ top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px`, transform }}>
                          <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
                            {String(hour).padStart(2, "0")}:00
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Colunas das equipas visíveis */}
                  {visibleColumns.length > 0 ? visibleColumns.map((col) => (
                    <DroppableColumn
                      key={col.key}
                      id={col.key}
                      className="flex-1 min-w-0 relative border-l border-[var(--color-border)] cursor-crosshair"
                      style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                      onClick={(e) => handleColumnClick(col.key, e)}
                    >
                      <GridLines totalHours={TOTAL_HOURS} slotsPerHour={SLOTS_PER_HOUR} slotHeight={SLOT_HEIGHT} />
                      {isToday && currentTop !== null && <CurrentTimeLine top={currentTop} />}

                      {(byTeam[col.id] ?? []).map((svc, idx, arr) => {
                        const next = arr[idx + 1];
                        const showTravel = next != null
                          && svc.location_lat != null && svc.location_lng != null
                          && next.location_lat != null && next.location_lng != null;
                        const travelMin  = showTravel
                          ? travelMinutes(svc.location_lat!, svc.location_lng!, next!.location_lat!, next!.location_lng!)
                          : 0;
                        const bottomY  = svcBottomPx(svc, START_HOUR, SLOT_HEIGHT);
                        const nextTopY = next ? svcTopPx(next, START_HOUR, SLOT_HEIGHT) : 0;
                        const gapPx    = nextTopY - bottomY;

                        return (
                          <React.Fragment key={svc.id}>
                            <ServiceBlock
                              service={svc}
                              teamId={col.key}
                              slotHeight={SLOT_HEIGHT}
                              startHour={START_HOUR}
                              stopIndex={arr.length > 1 ? idx + 1 : undefined}
                              onClick={(b) => setDetailSvc(localServices.find((s) => s.id === b.id) ?? null)}
                            />
                            {showTravel && gapPx > 20 && (
                              <div
                                className="absolute left-0 right-0 flex items-center justify-center pointer-events-none z-10"
                                style={{ top: `${bottomY + 2}px`, height: `${Math.max(gapPx - 4, 16)}px` }}
                              >
                                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-white border border-[var(--color-border)] text-[var(--color-text-muted)] shadow-sm whitespace-nowrap">
                                  ↓ ~{travelMin} min
                                </span>
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </DroppableColumn>
                  )) : (
                    /* Grelha vazia quando todas as equipas estão ocultas */
                    <div className="flex-1 relative border-l border-[var(--color-border)]"
                      style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}>
                      <GridLines totalHours={TOTAL_HOURS} slotsPerHour={SLOTS_PER_HOUR} slotHeight={SLOT_HEIGHT} />
                      {isToday && currentTop !== null && <CurrentTimeLine top={currentTop} />}
                      {columns.length > 0 && (
                        <div className="absolute inset-0 flex items-center justify-center gap-2">
                          <span className="text-sm text-[var(--color-text-muted)]">Todas as equipas estão ocultas.</span>
                          <button onClick={showAllTeams} className="text-sm text-[var(--color-primary)] hover:underline">Mostrar todas</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Overlay flutuante durante o drag */}
      <DragOverlay dropAnimation={null}>
        {draggingBlock && (
          <ServiceBlock
            service={draggingBlock.service}
            teamId={draggingBlock.teamId}
            slotHeight={SLOT_HEIGHT}
            startHour={START_HOUR}
            isOverlay
          />
        )}
      </DragOverlay>

      {/* Modal de conflito/confirmação — substitui window.confirm/prompt */}
      {pendingForce && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
          onClick={handleForceCancel}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold text-base text-[var(--color-text-main)] mb-1">{pendingForce.title}</h3>
            <p className="text-sm text-[var(--color-text-sub)] mb-4">{pendingForce.message}</p>

            {pendingForce.conflicts.length > 0 && (
              <ul className="mb-4 space-y-1.5">
                {pendingForce.conflicts.map((c) => (
                  <li key={c.id}
                    className="text-xs bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-amber-800">
                    <span className="font-semibold">#{c.reference_number}</span> — {c.location_name}{" "}
                    <span className="text-amber-600">
                      ({format(parseISO(c.scheduled_start), "HH:mm")}–{format(parseISO(c.scheduled_end), "HH:mm")})
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mb-5">
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Motivo</label>
              <input
                ref={reasonRef}
                type="text"
                defaultValue="Ajuste operacional validado pela gestora"
                className="w-full text-sm border border-[var(--color-border)] rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={handleForceCancel}
                className="px-4 py-2 text-sm font-medium rounded-xl border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
                Cancelar
              </button>
              <button onClick={handleForceConfirm}
                className="px-4 py-2 text-sm font-medium rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-colors">
                Mover mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sheets */}
      <ServiceCreateSheet
        open={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        onCreated={handleChanged}
        companyId={companyId}
        date={createSheet?.date ?? today ?? new Date()}
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
      <TeamAllocationModal
        open={allocationOpen}
        onClose={() => setAllocationOpen(false)}
        companyId={companyId}
        selectedDate={selectedDate}
        teams={teams}
      />
      <ClientNotificationsModal
        open={avisosOpen}
        onClose={() => setAvisosOpen(false)}
        companyId={companyId}
        selectedDate={selectedDate}
      />
    </DndContext>
  );
}
