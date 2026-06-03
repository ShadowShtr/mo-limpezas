"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks, subWeeks, addDays, addMinutes,
  isSameDay, parseISO, format, differenceInMinutes,
  endOfWeek,
} from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, X, Users, LayoutGrid, List, Bell } from "lucide-react";
import {
  DndContext, DragOverlay,
  PointerSensor, useSensor, useSensors,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { ServiceBlock, type ServiceForBlock } from "./service-block";
import { DroppableColumn } from "./droppable-column";
import { ServiceCreateSheet } from "./service-create-sheet";
import { ServiceDetailSheet } from "./service-detail-sheet";
import { TeamAllocationModal } from "./team-allocation-modal";
import { CalendarListView } from "./calendar-list-view";
import { ClientNotificationsModal } from "./client-notifications-modal";
import { rescheduleService } from "../_actions/reschedule";
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
  isDemo?: boolean;
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

// ─── Linhas do grid (definido antes do componente para evitar forward-reference) ──

function GridLines({
  totalHours, slotsPerHour, slotHeight,
}: { totalHours: number; slotsPerHour: number; slotHeight: number }) {
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
          style={{
            top: `${(i * slotsPerHour + 1) * slotHeight}px`,
            borderTop: "1px dashed var(--color-border)",
            opacity: 0.4,
          }}
        />
      ))}
    </>
  );
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function CalendarView({
  services, teams, weekStartISO, selectedDateISO,
  companyId, userId, clients, locations,
  isDemo = false,
}: CalendarViewProps) {
  const router    = useRouter();
  const weekStart = parseISO(weekStartISO);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Previne o onClick da coluna de disparar imediatamente após um drag terminar
  const wasDragging = useRef(false);

  // ── dnd-kit sensors ──────────────────────────────────────────────────────
  // activationConstraint: distance 8px — click não ativa drag
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(() => parseISO(selectedDateISO));
  // null no servidor — calculado só no cliente (evita hydration mismatch com new Date())
  const [currentTop,   setCurrentTop]   = useState<number | null>(null);
  // today calculado só no cliente (null no servidor para evitar hydration mismatch)
  const [today,        setToday]        = useState<Date | null>(null);
  const [createSheet,       setCreateSheet]       = useState<{ date: Date; startTime: string; teamId: string } | null>(null);
  const [detailSvc,         setDetailSvc]         = useState<ServiceFull | null>(null);
  const [allocationOpen,    setAllocationOpen]    = useState(false);
  const [avisosOpen,        setAvisosOpen]        = useState(false);
  const [viewMode,          setViewMode]          = useState<"calendar" | "list">("calendar");

  // ── Drag state ───────────────────────────────────────────────────────────
  const [draggingBlock, setDraggingBlock] = useState<{ service: ServiceForBlock; teamId: string } | null>(null);
  const [conflictMsg,   setConflictMsg]   = useState<string | null>(null);

  // Inicializar today e currentTop no cliente (evita hydration mismatch)
  useEffect(() => {
    setToday(new Date());
    setCurrentTop(computeTimeTop(parseISO(selectedDateISO)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincronizar selectedDate quando o servidor re-renderiza (navegação de semana)
  useEffect(() => {
    const d = parseISO(selectedDateISO);
    setSelectedDate(d);
    setCurrentTop(computeTimeTop(d));
    setToday(new Date());
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
    // Ignorar click que vem imediatamente a seguir a um drag
    if (wasDragging.current) { wasDragging.current = false; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setCreateSheet({ date: selectedDate, startTime: yToTime(y), teamId: teamId === "__sem__" ? "" : teamId });
  }

  function handleChanged() { router.refresh(); }

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

    const { service } = active.data.current as { service: ServiceForBlock; teamId: string };
    const newTeamId = over.id === "__sem__" ? null : (over.id as string);

    // Calcular novo horário a partir do delta Y (cada SLOT_HEIGHT px = 30 min)
    const minutesDelta = Math.round((delta.y / SLOT_HEIGHT) * 30);
    // Arredondar aos 15 min mais próximos
    const roundedDelta = Math.round(minutesDelta / 15) * 15;
    if (roundedDelta === 0 && newTeamId === (active.data.current as { teamId: string }).teamId) return;

    const origStart   = parseISO(service.scheduled_start);
    const origEnd     = parseISO(service.scheduled_end);
    const duration    = differenceInMinutes(origEnd, origStart);

    let newStart = addMinutes(origStart, roundedDelta);
    let newEnd   = addMinutes(newStart, duration);

    // Clamp: não permitir sair das horas visíveis (07:00 – 22:00)
    const dayBase   = new Date(newStart);
    dayBase.setHours(START_HOUR, 0, 0, 0);
    const dayEnd    = new Date(newStart);
    dayEnd.setHours(END_HOUR, 0, 0, 0);

    if (newStart < dayBase) {
      newStart = dayBase;
      newEnd   = addMinutes(newStart, duration);
    }
    if (newEnd > dayEnd) {
      newEnd   = dayEnd;
      newStart = addMinutes(newEnd, -duration);
    }

    // Atualizar optimisticamente na UI e depois confirmar no servidor
    const result = await rescheduleService(
      service.id,
      newStart.toISOString(),
      newEnd.toISOString(),
      newTeamId,
    );

    if (!result.ok) {
      setConflictMsg(`Erro ao reagendar: ${result.error}`);
      return;
    }

    if (result.conflicts.length > 0) {
      const names = result.conflicts.map((c) => `#${c.reference_number} ${c.location_name}`).join(", ");
      setConflictMsg(`Conflito de horário com: ${names}`);
    }

    router.refresh();
  }

  // today é null no SSR — guards abaixo garantem segurança
  const isToday  = today !== null && isSameDay(selectedDate, today);
  const weekRange = `${format(weekStart, "d MMM", { locale: pt })} – ${format(endOfWeek(weekStart, { weekStartsOn: 1 }), "d MMM yyyy", { locale: pt })}`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
              const isTody = today !== null && isSameDay(day, today);
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

          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-text-main)] hidden sm:block">
              {format(selectedDate, "EEEE, d 'de' MMMM yyyy", { locale: pt })}
            </span>
            <span className="text-xs text-[var(--color-text-muted)] hidden md:block mr-1">{weekRange}</span>
            {/* Toggle calendário / lista */}
            <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              <button
                onClick={() => setViewMode("calendar")}
                title="Vista calendário"
                className={`p-1.5 transition-colors ${viewMode === "calendar" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("list")}
                title="Vista lista"
                className={`p-1.5 transition-colors ${viewMode === "list" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
            {!isDemo && (
              <>
                <button
                  onClick={() => setAvisosOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors"
                >
                  <Bell className="w-3.5 h-3.5" />
                  Avisos
                </button>
                <button
                  onClick={() => setAllocationOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors"
                >
                  <Users className="w-3.5 h-3.5" />
                  Equipas
                </button>
                <button
                  onClick={() => setCreateSheet({ date: selectedDate, startTime: "09:00", teamId: teams[0]?.id ?? "" })}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Novo serviço
                </button>
              </>
            )}
            {isDemo && (
              <a
                href="/dashboard/equipas"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors"
              >
                Criar equipas para começar
              </a>
            )}
          </div>
        </div>

        {/* Banner de demonstração */}
        {isDemo && (
          <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
            <span className="text-xs font-medium text-amber-700">
              👁 Modo de demonstração — dados de exemplo para visualização. Aplica as migrations e cria equipas para começar a usar.
            </span>
            <a href="/dashboard/equipas" className="text-xs font-semibold text-amber-800 underline ml-auto shrink-0">
              Criar equipas →
            </a>
          </div>
        )}

        {/* Banner de conflito de horário */}
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
            services={services}
            teams={teams}
            selectedDate={selectedDate}
            onChanged={handleChanged}
          />
        )}

        {/* ── Grid do calendário ─────────────────────────────────────────── */}
        {viewMode === "calendar" ?
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

          {/* Cabeçalho das equipas */}
          <div className="flex bg-white border-b border-[var(--color-border)] shrink-0">
            <div className="w-14 shrink-0 border-r border-[var(--color-border)]" />
            {columns.length > 0 ? columns.map((col) => (
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
            )) : (
              <div className="flex-1 px-4 py-2.5 border-l border-[var(--color-border)] flex items-center gap-2">
                <span className="text-sm text-[var(--color-text-muted)]">Sem equipas —</span>
                <a href="/dashboard/equipas" className="text-sm text-[var(--color-primary)] hover:underline font-medium">
                  Criar equipas
                </a>
              </div>
            )}
          </div>

          {/* Área de scroll vertical — sempre renderizada */}
          <div ref={scrollRef} className="flex-1 overflow-auto">
            <div
              className="flex"
              style={{
                height: `${TOTAL_SLOTS * SLOT_HEIGHT}px`,
                minWidth: `${56 + Math.max(columns.length, 1) * 160}px`,
              }}
            >
              {/* Coluna de horas */}
              <div className="w-14 shrink-0 border-r border-[var(--color-border)] relative bg-white">
                {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
                  const hour = START_HOUR + i;
                  const transform = i === 0
                    ? "translateY(2px)"
                    : i === TOTAL_HOURS
                    ? "translateY(-100%)"
                    : "translateY(-50%)";
                  return (
                    <div
                      key={hour}
                      className="absolute right-2 select-none"
                      style={{ top: `${i * SLOTS_PER_HOUR * SLOT_HEIGHT}px`, transform }}
                    >
                      <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
                        {String(hour).padStart(2, "0")}:00
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Colunas das equipas (ou coluna vazia se não houver equipas) */}
              {columns.length > 0 ? columns.map((col) => (
                <DroppableColumn
                  key={col.key}
                  id={col.key}
                  className="flex-1 min-w-[160px] relative border-l border-[var(--color-border)] cursor-crosshair"
                  style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                  onClick={(e) => handleColumnClick(col.key, e)}
                >
                  <GridLines
                    totalHours={TOTAL_HOURS}
                    slotsPerHour={SLOTS_PER_HOUR}
                    slotHeight={SLOT_HEIGHT}
                  />

                  {isToday && currentTop !== null && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: `${currentTop}px` }}
                    >
                      <div className="w-full h-0.5 bg-red-500" />
                      <div className="absolute -left-1 -top-1.5 w-3 h-3 rounded-full bg-red-500" />
                    </div>
                  )}

                  {(byTeam[col.id] ?? []).map((svc) => (
                    <ServiceBlock
                      key={svc.id}
                      service={svc}
                      teamId={col.key}
                      slotHeight={SLOT_HEIGHT}
                      startHour={START_HOUR}
                      onClick={(b) => setDetailSvc(services.find((s) => s.id === b.id) ?? null)}
                    />
                  ))}
                </DroppableColumn>
              )) : (
                /* Coluna vazia com grades — para quando não há equipas ainda */
                <div
                  className="flex-1 min-w-[160px] relative border-l border-[var(--color-border)]"
                  style={{ height: `${TOTAL_SLOTS * SLOT_HEIGHT}px` }}
                >
                  <GridLines
                    totalHours={TOTAL_HOURS}
                    slotsPerHour={SLOTS_PER_HOUR}
                    slotHeight={SLOT_HEIGHT}
                  />
                  {isToday && currentTop !== null && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: `${currentTop}px` }}
                    >
                      <div className="w-full h-0.5 bg-red-500" />
                      <div className="absolute -left-1 -top-1.5 w-3 h-3 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        : null}

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

      {/* Sheets */}
      <ServiceCreateSheet
        open={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        onCreated={handleChanged}
        companyId={companyId}
        userId={userId}
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
        userId={userId}
      />
    </DndContext>
  );
}

