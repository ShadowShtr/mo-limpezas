"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  addWeeks, subWeeks, addDays,
  isSameDay, parseISO, format,
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
import { MonthDatePicker } from "./month-date-picker";
import { CalendarListView } from "./calendar-list-view";
import { ClientNotificationsModal } from "./client-notifications-modal";
import { BuildingsColumn } from "./buildings-column";
import { useCalendarStaticData } from "./calendar-static-data-context";
import { rescheduleService, type ConflictInfo } from "../_actions/reschedule";
import { getCompanySettings } from "@/app/actions/settings";
import type { BuildingCard } from "@/app/actions/building-cards";
import type { Database, BuildingCardWeekday } from "@/types/database";

// ─── Constantes ───────────────────────────────────────────────────────────────

const START_HOUR    = 7;
const END_HOUR      = 18;
const TOTAL_HOURS   = END_HOUR - START_HOUR;
const MIN_SLOT_HEIGHT = 26; // altura mínima por slot de 15 min (espaço p/ etiquetas não colarem)
const SLOTS_PER_HOUR = 4;   // divisões de 15 em 15 minutos
const SLOT_MIN      = 60 / SLOTS_PER_HOUR; // minutos por slot
const TOTAL_SLOTS   = TOTAL_HOURS * SLOTS_PER_HOUR;
const GUTTER_W      = 56;
// Largura MÍNIMA de cada coluna de equipa. As colunas esticam/encolhem para
// preencher exatamente o espaço visível (sem scroll horizontal) enquanto
// couberem todas com pelo menos esta largura; só quando não há espaço para
// todas ao mesmo tamanho mínimo é que aparece scroll horizontal — os cards
// nunca ficam mais estreitos do que isto, ilegíveis.
const COLUMN_MIN_W  = 128;
// A coluna Prédios precisa de mais espaço do que uma coluna de equipa: cada
// card tem ícone de arrastar + botões de editar/apagar + badge de equipa com
// texto mais longo ("Equipa 13 - Prédios Alverca") — a 128px o texto fica a
// cortar/partir a meio da palavra.
const PREDIOS_COLUMN_MIN_W = 190;
const HEADER_H      = 44;
const BUILDINGS_COL_ID = "__predios__";
const WEEKDAY_KEYS: BuildingCardWeekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team   = { id: string; name: string; color: string; member_count?: number };

/** Versão segura de ServiceFull para o payload do calendário.
 *  Campos sensíveis (código de acesso, instruções, contactos do cliente) são
 *  stripped no RSC — o browser nunca recebe os valores brutos.
 *  O boolean location_has_access_code é pré-calculado server-side.
 */
export type ServiceCalendar = Omit<
  ServiceFull,
  "location_access_code" | "location_instructions" | "client_phone" | "client_email"
> & {
  location_has_access_code: boolean;
  location_access_code: null;
  location_instructions: null;
  client_phone: null;
  client_email: null;
};

interface CalendarViewProps {
  services: ServiceCalendar[];
  teams: Team[];
  weekStartISO: string;
  selectedDateISO: string;
  companyId: string;
  buildingCards: BuildingCard[];
  isDemo?: boolean;
}

type PendingForce = {
  serviceId: string;
  newStart: string;
  newEnd: string;
  newTeamId: string | null;
  previous: ServiceCalendar[];
  title: string;
  message: string;
  conflicts: ConflictInfo[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toBlock(s: ServiceCalendar): ServiceForBlock {
  return {
    id: s.id,
    reference_number: s.reference_number,
    scheduled_start: s.scheduled_start,
    scheduled_end: s.scheduled_end,
    status: s.status,
    location_name: s.location_name,
    location_address: s.location_address,
    location_has_access_code: s.location_has_access_code,
    location_has_key: s.location_has_key ?? false,
    location_key_label: s.location_key_label ?? null,
    location_lat: s.location_lat ?? null,
    location_lng: s.location_lng ?? null,
    client_name: s.client_name,
    calculated_value: s.calculated_value,
    manual_value: s.manual_value,
    apply_vat: s.apply_vat,
    notes: s.notes,
    team_color: s.team_color ?? null,
    team_name: s.team_name ?? null,
    payment_status: s.payment_status ?? null,
    canSeeFinancials: true, // calendário é manager-only
  };
}

function svcTopPx(svc: ServiceForBlock, startHour: number, slotH: number): number {
  const start = parseISO(svc.scheduled_start);
  return ((start.getHours() * 60 + start.getMinutes() - startHour * 60) / SLOT_MIN) * slotH;
}

function svcBottomPx(svc: ServiceForBlock, startHour: number, slotH: number): number {
  const end = parseISO(svc.scheduled_end);
  return ((end.getHours() * 60 + end.getMinutes() - startHour * 60) / SLOT_MIN) * slotH;
}

/**
 * Atribui sub-colunas (lanes) a serviços que se sobrepõem no tempo dentro da
 * mesma coluna de equipa, para ficarem lado a lado em vez de empilhados.
 * Devolve um Map id → { lane, lanes }.
 */
function computeLanes(items: ServiceForBlock[]): Map<string, { lane: number; lanes: number }> {
  const map = new Map<string, { lane: number; lanes: number }>();
  const ms = (iso: string) => new Date(iso).getTime();
  const sorted = [...items].sort((a, b) => ms(a.scheduled_start) - ms(b.scheduled_start));

  let i = 0;
  while (i < sorted.length) {
    // Junta um grupo de serviços que se sobrepõem em cadeia
    let clusterEnd = ms(sorted[i].scheduled_end);
    const cluster = [sorted[i]];
    let j = i + 1;
    while (j < sorted.length && ms(sorted[j].scheduled_start) < clusterEnd) {
      cluster.push(sorted[j]);
      clusterEnd = Math.max(clusterEnd, ms(sorted[j].scheduled_end));
      j++;
    }
    // Atribui lanes de forma greedy dentro do grupo
    const laneEnds: number[] = [];
    for (const it of cluster) {
      let placed = -1;
      for (let L = 0; L < laneEnds.length; L++) {
        if (ms(it.scheduled_start) >= laneEnds[L]) { placed = L; break; }
      }
      if (placed === -1) { placed = laneEnds.length; laneEnds.push(0); }
      laneEnds[placed] = ms(it.scheduled_end);
      map.set(it.id, { lane: placed, lanes: 1 });
    }
    const lanes = laneEnds.length;
    for (const it of cluster) map.get(it.id)!.lanes = lanes;
    i = j;
  }
  return map;
}

function computeTimeTop(date: Date, slotH: number): number | null {
  if (!isSameDay(date, new Date())) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < START_HOUR * 60 || nowMin > END_HOUR * 60) return null;
  return ((nowMin - START_HOUR * 60) / SLOT_MIN) * slotH;
}

function yToTime(y: number, slotH: number): string {
  const slot = Math.max(0, Math.min(Math.floor(y / slotH), TOTAL_SLOTS - 1));
  const totalMin = START_HOUR * 60 + slot * SLOT_MIN;
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
      {Array.from({ length: totalHours * slotsPerHour }, (_, s) => {
        const sub = s % slotsPerHour;
        if (sub === 0) return null; // a linha cheia da hora já é desenhada acima
        const isHalf = sub * 2 === slotsPerHour; // marca dos 30 min mais visível
        return (
          <div
            key={`q-${s}`}
            className="absolute left-0 right-0 border-t border-[var(--color-border)] pointer-events-none"
            style={{ top: `${s * slotHeight}px`, opacity: isHalf ? 0.7 : 0.45 }}
          />
        );
      })}
    </>
  );
}

/**
 * Células clicáveis de 15 min. Apenas afordância visual (hover + "+"); o clique
 * borbulha para a coluna, que calcula a hora pela posição vertical.
 */
function SlotCells({ slotHeight, totalSlots }: { slotHeight: number; totalSlots: number }) {
  return (
    <div className="absolute inset-0 z-0">
      {Array.from({ length: totalSlots }, (_, s) => (
        <div
          key={s}
          className="absolute left-0 right-0 group hover:bg-[var(--color-primary)]/[0.06] transition-colors"
          style={{ top: `${s * slotHeight}px`, height: `${slotHeight}px` }}
        >
          <span className="hidden group-hover:flex absolute inset-0 items-center justify-center text-[var(--color-primary)] text-xs font-semibold pointer-events-none">
            +
          </span>
        </div>
      ))}
    </div>
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
  companyId, buildingCards, isDemo = false,
}: CalendarViewProps) {
  const router     = useRouter();
  const { clients, locations } = useCalendarStaticData();
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
  // Altura do slot adaptada à área visível: preenche todo o espaço, sem buraco em baixo.
  const [slotH,        setSlotH]        = useState<number>(MIN_SLOT_HEIGHT);
  const [today,        setToday]        = useState<Date | null>(null);
  const [createSheet,    setCreateSheet]    = useState<{ date: Date; startTime: string; teamId: string } | null>(null);
  const [detailSvc,      setDetailSvc]      = useState<ServiceCalendar | null>(null);
  const [detailEdit,     setDetailEdit]     = useState(false);
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [avisosOpen,     setAvisosOpen]     = useState(false);
  const [viewMode,       setViewMode]       = useState<"calendar" | "list">("calendar");
  const [localServices,  setLocalServices]  = useState<ServiceCalendar[]>(services);
  const [localBuildingCards, setLocalBuildingCards] = useState<BuildingCard[]>(buildingCards);
  const [draggingBlock,  setDraggingBlock]  = useState<{ service: ServiceForBlock; teamId: string } | null>(null);
  const [conflictMsg,    setConflictMsg]    = useState<string | null>(null);
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [pendingForce,   setPendingForce]   = useState<PendingForce | null>(null);
  // Taxa de IVA da empresa — para o tooltip do card mostrar o valor COM IVA,
  // igual ao painel de detalhe (evita o mesmo serviço mostrar valores
  // diferentes em sítios diferentes do calendário).
  const [vatRate, setVatRate] = useState<number>(23);

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

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    setToday(new Date());
    setCurrentTop(computeTimeTop(parseISO(selectedDateISO), slotH));
  }, []);

  useEffect(() => {
    const d = parseISO(selectedDateISO);
    setSelectedDate(d);
    setCurrentTop(computeTimeTop(d, slotH));
    setToday(new Date());
  }, [selectedDateISO]);

  useEffect(() => { setLocalServices(services); }, [services]);
  useEffect(() => { setLocalBuildingCards(buildingCards); }, [buildingCards]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  useEffect(() => {
    let cancelled = false;
    getCompanySettings()
      .then((s) => { if (!cancelled && s?.vat_rate != null) setVatRate(s.vat_rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setCurrentTop(computeTimeTop(selectedDate, slotH)), 60_000);
    return () => clearInterval(id);
  }, [selectedDate, slotH]);

  // Adapta a altura do slot para a grelha preencher exatamente a área visível.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () => {
      const avail = el.clientHeight - HEADER_H;
      // +2px por slot → a grelha fica um pouco maior que a área visível, dando
      // uma rolagem moderada (meia "bolinha" para cima e para baixo).
      const next = Math.max(MIN_SLOT_HEIGHT, Math.floor(avail / TOTAL_SLOTS) + 2);
      setSlotH((prev) => (prev === next ? prev : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  // Recalcula a linha "agora" quando a altura do slot muda.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setCurrentTop(computeTimeTop(selectedDate, slotH)); }, [slotH, selectedDate]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const top = computeTimeTop(selectedDate, slotH);
    scrollRef.current.scrollTop = HEADER_H + (top !== null ? Math.max(0, top - 80) : SLOTS_PER_HOUR * slotH);
  }, [selectedDate, slotH]);

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
      // Se a equipa do serviço não tiver coluna (equipa inativa/apagada),
      // encaminha para "Sem equipa" para o serviço nunca desaparecer do calendário.
      const key = s.team_id && map[s.team_id] ? s.team_id : "__sem__";
      map[key].push(toBlock(s));
    });
    Object.keys(map).forEach((k) => map[k].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)));
    return map;
  }, [dayServices, teams]);

  // Dia da semana da data selecionada (para a coluna Prédios, recorrente).
  const selectedWeekday = WEEKDAY_KEYS[selectedDate.getDay()];

  const dayBuildingCards = useMemo(
    () => localBuildingCards
      .filter((c) => c.weekday === selectedWeekday)
      .sort((a, b) => a.sort_order - b.sort_order),
    [localBuildingCards, selectedWeekday],
  );

  // Todas as colunas (equipas + "sem equipa" se houver + Prédios, sempre por último)
  const columns = useMemo<Array<Team & { key: string }>>(() => {
    const base = teams.map((t) => ({ ...t, key: t.id }));
    if (byTeam["__sem__"]?.length > 0)
      base.push({ id: "__sem__", name: "Sem equipa", color: "#94A3B8", key: "__sem__" });
    base.push({ id: BUILDINGS_COL_ID, name: "Prédios", color: "#64748B", key: BUILDINGS_COL_ID });
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
    // Atualiza o estado local já (resposta instantânea) e também o URL — sem
    // isto, o dia selecionado dentro da mesma semana só existia no estado do
    // React; qualquer router.refresh() (ex.: depois de gravar algo no painel
    // do serviço) recarregava a página a partir do URL, que nunca tinha saído
    // do dia de hoje, e a seleção "voltava" para hoje sozinha.
    setSelectedDate(day);
    setCurrentTop(computeTimeTop(day, slotH));
    router.push(`/dashboard/calendario?date=${format(day, "yyyy-MM-dd")}`);
  }

  function handleColumnClick(teamId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (wasDragging.current) { wasDragging.current = false; return; }
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    setCreateSheet({ date: selectedDate, startTime: yToTime(y, slotH), teamId: teamId === "__sem__" ? "" : teamId });
  }

  function handleChanged() { router.refresh(); }

  async function handlePdf() {
    setPdfLoading(true);
    try {
      const { generateDayPdf } = await import("./day-pdf");
      const routes: TeamRoute[] = visibleColumns
        .filter((col) => col.key !== BUILDINGS_COL_ID)
        .map((col) => ({
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

    const { active, over } = event;
    if (!over || !active.data.current) return;

    const { service, teamId: fromColKey } = active.data.current as { service: ServiceForBlock; teamId: string };
    const newTeamId  = over.id === "__sem__" ? null : (over.id as string);
    const origTeamId = fromColKey === "__sem__" ? null : fromColKey;

    // ── Horário: deslocamento vertical → passos de 30 min ──────────────────────
    const pad = (n: number) => String(n).padStart(2, "0");
    const buildTime = (dayStr: string, mins: number) =>
      `${dayStr}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;

    const startD = parseISO(service.scheduled_start);
    const endD   = parseISO(service.scheduled_end);
    const dayStr = format(startD, "yyyy-MM-dd");
    const origStartMin = startD.getHours() * 60 + startD.getMinutes();
    const durMin = (endD.getHours() * 60 + endD.getMinutes()) - origStartMin;

    // Cada slot = 15 min; arredonda o arrasto vertical ao slot mais próximo
    const slotsMoved = slotH > 0 ? Math.round(event.delta.y / slotH) : 0;
    let newStartMin = origStartMin + slotsMoved * SLOT_MIN;
    // Mantém dentro do horário de trabalho (e o fim não passa do limite)
    newStartMin = Math.max(START_HOUR * 60, Math.min(newStartMin, END_HOUR * 60 - durMin));

    const newStart = buildTime(dayStr, newStartMin);
    const newEnd   = buildTime(dayStr, newStartMin + durMin);

    const teamChanged = newTeamId !== origTeamId;
    const timeChanged = newStartMin !== origStartMin;

    // Sem mudança de equipa nem de horário → nada a fazer
    if (!teamChanged && !timeChanged) return;

    const previous   = localServices;
    const targetTeam = teams.find((t) => t.id === newTeamId);

    // Atualização otimista (equipa + horário)
    setLocalServices((curr) => curr.map((s) =>
      s.id === service.id
        ? {
            ...s,
            team_id: newTeamId,
            team_name: targetTeam?.name ?? (teamChanged ? null : s.team_name),
            team_color: targetTeam?.color ?? (teamChanged ? null : s.team_color),
            scheduled_start: newStart,
            scheduled_end: newEnd,
          }
        : s,
    ));

    const result = await rescheduleService(service.id, newStart, newEnd, newTeamId);

    if (!result.ok && result.canForce) {
      setPendingForce({
        serviceId: service.id,
        newStart,
        newEnd,
        newTeamId,
        previous,
        title: "Serviço em curso",
        message: `O serviço está em curso. Confirme que pretende transferi-lo para ${targetTeam?.name ?? "outra equipa"}.`,
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
    } else if (teamChanged) {
      setConflictMsg(
        timeChanged
          ? `Serviço movido para ${targetTeam?.name ?? "outra equipa"} às ${buildTime(dayStr, newStartMin).slice(11, 16)}.`
          : `Serviço atribuído a ${targetTeam?.name ?? "outra equipa"}.`,
      );
    } else {
      setConflictMsg(`Serviço movido para as ${buildTime(dayStr, newStartMin).slice(11, 16)}.`);
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

          <MonthDatePicker
            selectedDate={selectedDate}
            today={today}
            onSelect={(d) => router.push(`/dashboard/calendario?date=${format(d, "yyyy-MM-dd")}`)}
          />

          <div className="ml-auto flex items-center gap-2">
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
            {/* Colunas esticam/encolhem para caber sem scroll; scroll horizontal só como reserva (COLUMN_MIN_W) */}
            <div ref={scrollRef} className="flex-1 overflow-auto calendar-scroll">
              <div style={{ minHeight: `${HEADER_H + TOTAL_SLOTS * slotH}px` }}>

                {/* ── Cabeçalho das equipas — sticky no topo ─────────────────── */}
                <div className="flex sticky top-0 z-30 bg-white border-b border-[var(--color-border)] shadow-sm"
                  style={{ height: `${HEADER_H}px` }}>
                  {/* Célula de canto — sticky nos dois eixos para nunca sair de vista */}
                  <div className="shrink-0 sticky left-0 z-40 border-r border-[var(--color-border)] bg-white" style={{ width: `${GUTTER_W}px` }} />

                  {visibleColumns.length > 0 ? visibleColumns.map((col) => (
                    <div key={col.key}
                      className="flex-1 relative px-2 flex items-center border-l border-[var(--color-border)] bg-white overflow-hidden"
                      style={{ minWidth: `${col.key === BUILDINGS_COL_ID ? PREDIOS_COLUMN_MIN_W : COLUMN_MIN_W}px` }}>
                      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ backgroundColor: col.color }} />
                      <div className="flex items-center gap-1.5 w-full min-w-0">
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                        <span className="text-xs font-semibold text-[var(--color-text-main)] truncate">{col.name}</span>
                        <span className="ml-auto text-[10px] font-semibold text-[var(--color-text-sub)] tabular-nums bg-[var(--color-background)] rounded-full px-1.5 py-0.5 shrink-0">
                          {col.key === BUILDINGS_COL_ID ? dayBuildingCards.length : byTeam[col.id]?.length ?? 0}
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
                <div className="flex" style={{ height: `${TOTAL_SLOTS * slotH}px` }}>

                  {/* Coluna de horas — marcas de 15 em 15 min */}
                  <div className="shrink-0 sticky left-0 z-20 border-r border-[var(--color-border)] relative bg-white"
                    style={{ width: `${GUTTER_W}px` }}>
                    {Array.from({ length: TOTAL_SLOTS + 1 }, (_, s) => {
                      const totalMin = (START_HOUR * 60) + s * SLOT_MIN;
                      const hh = Math.floor(totalMin / 60);
                      const mm = totalMin % 60;
                      const isHour = mm === 0;
                      // 1ª etiqueta alinha ao topo, última ao fundo; as restantes centradas na linha.
                      const transform = s === 0 ? "translateY(0)" : s === TOTAL_SLOTS ? "translateY(-100%)" : "translateY(-50%)";
                      return (
                        <div key={s} className="absolute right-2 select-none" style={{ top: `${s * slotH}px`, transform }}>
                          <span className={isHour
                            ? "text-[10px] text-[var(--color-text-main)] font-semibold tabular-nums"
                            : "text-[10px] text-[var(--color-text-muted)] tabular-nums"}>
                            {String(hh).padStart(2, "0")}:{String(mm).padStart(2, "0")}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Colunas das equipas visíveis */}
                  {visibleColumns.length > 0 ? visibleColumns.map((col) => {
                    if (col.key === BUILDINGS_COL_ID) {
                      return (
                        <BuildingsColumn
                          key={col.key}
                          weekday={selectedWeekday}
                          cards={dayBuildingCards}
                          teams={teams}
                          onChanged={handleChanged}
                          minWidth={PREDIOS_COLUMN_MIN_W}
                        />
                      );
                    }
                    const colServices = byTeam[col.id] ?? [];
                    const laneMap = computeLanes(colServices);
                    return (
                    <DroppableColumn
                      key={col.key}
                      id={col.key}
                      className="flex-1 relative border-l border-[var(--color-border)] cursor-crosshair"
                      style={{ height: `${TOTAL_SLOTS * slotH}px`, minWidth: `${COLUMN_MIN_W}px` }}
                      onClick={(e) => handleColumnClick(col.key, e)}
                    >
                      <GridLines totalHours={TOTAL_HOURS} slotsPerHour={SLOTS_PER_HOUR} slotHeight={slotH} />
                      <SlotCells slotHeight={slotH} totalSlots={TOTAL_SLOTS} />
                      {isToday && currentTop !== null && <CurrentTimeLine top={currentTop} />}

                      {colServices.map((svc, idx, arr) => {
                        const { lane = 0, lanes = 1 } = laneMap.get(svc.id) ?? {};
                        const next = arr[idx + 1];
                        // Só mostra tempo de viagem entre serviços em sequência (não sobrepostos)
                        const showTravel = lanes === 1 && next != null
                          && svc.location_lat != null && svc.location_lng != null
                          && next.location_lat != null && next.location_lng != null;
                        const travelMin  = showTravel
                          ? travelMinutes(svc.location_lat!, svc.location_lng!, next!.location_lat!, next!.location_lng!)
                          : 0;
                        const bottomY  = svcBottomPx(svc, START_HOUR, slotH);
                        const nextTopY = next ? svcTopPx(next, START_HOUR, slotH) : 0;
                        const gapPx    = nextTopY - bottomY;

                        return (
                          <React.Fragment key={svc.id}>
                            <ServiceBlock
                              service={svc}
                              teamId={col.key}
                              slotHeight={slotH}
                              startHour={START_HOUR}
                              stopIndex={arr.length > 1 ? idx + 1 : undefined}
                              lane={lane}
                              lanes={lanes}
                              vatRate={vatRate}
                              onClick={(b) => { setDetailEdit(false); setDetailSvc(localServices.find((s) => s.id === b.id) ?? null); }}
                              onEdit={(b) => { setDetailEdit(true); setDetailSvc(localServices.find((s) => s.id === b.id) ?? null); }}
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
                    );
                  }) : (
                    /* Grelha vazia quando todas as equipas estão ocultas */
                    <div className="flex-1 relative border-l border-[var(--color-border)]"
                      style={{ height: `${TOTAL_SLOTS * slotH}px` }}>
                      <GridLines totalHours={TOTAL_HOURS} slotsPerHour={SLOTS_PER_HOUR} slotHeight={slotH} />
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
            slotHeight={slotH}
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
        initialEdit={detailEdit}
        onClose={() => { setDetailSvc(null); setDetailEdit(false); }}
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
