"use client";

import { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { X, Loader2, Car, RefreshCw, ChevronDown, User, GripVertical } from "lucide-react";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import {
  getAllocationsForDate,
  upsertAllocation,
  removeAllocation,
  moveCollaboratorToTeam,
  type VehicleAllocation,
} from "@/app/actions/vehicles";
import { DroppableColumn } from "./droppable-column";

// ─── Constantes ───────────────────────────────────────────────────────────────

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa:     "Baixa médica",
  doenca_sem_baixa:     "Doença",
  pessoal_justificado:  "Pessoal just.",
  pessoal_injustificado:"Pessoal injust.",
  ferias:               "Férias",
  feriado:              "Feriado",
  formacao:             "Formação",
  outro:                "Outro",
};

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TeamBase {
  id: string;
  name: string;
  color: string;
}

interface Member {
  id: string;
  full_name: string;
  avatar_url: string | null;
}

interface TeamWithMembers extends TeamBase {
  members: Member[];
}

interface AbsentCollaborator extends Member {
  absence_type: string;
}

interface VehicleOption {
  id: string;
  model: string;
  plate: string;
}

// Estado de alocação por equipa (gerido localmente antes de guardar)
interface TeamAllocation {
  vehicleId: string;
  driverId: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  selectedDate: Date;
  teams: TeamBase[];
}

// ─── Chip de colaboradora arrastável ────────────────────────────────────────────

function MemberChip({
  member, color, fromTeamId, moved,
}: { member: Member; color: string; fromTeamId: string; moved: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `member-${member.id}`,
    data: { collaboratorId: member.id, fromTeamId, fullName: member.full_name },
  });

  return (
    <span className="relative inline-flex">
      <span
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-xs font-medium text-white cursor-grab active:cursor-grabbing touch-none select-none"
        style={{ backgroundColor: color, opacity: isDragging ? 0.4 : 1 }}
        title={`${member.full_name} — arrasta para outra equipa`}
      >
        <GripVertical className="w-3 h-3 opacity-70 shrink-0" />
        {member.full_name.split(" ")[0]}
      </span>
      {moved && (
        <span
          className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white"
          title="Movida de outra equipa (só hoje)"
        />
      )}
    </span>
  );
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function TeamAllocationModal({
  open, onClose, companyId, selectedDate, teams,
}: Props) {
  const supabase = createClient();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const [loading,  setLoading]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [message,  setMessage]  = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  const [allocated, setAllocated] = useState<TeamWithMembers[]>([]);
  const [available, setAvailable] = useState<Member[]>([]);
  const [absent,    setAbsent]    = useState<AbsentCollaborator[]>([]);
  const [vehicles,  setVehicles]  = useState<VehicleOption[]>([]);

  // vehicleId + driverId por team
  const [allocationMap, setAllocationMap] = useState<Record<string, TeamAllocation>>({});

  // Reatribuições do dia: collaboratorId → equipa com que trabalha hoje
  const [overrideMap, setOverrideMap] = useState<Record<string, string>>({});

  // Chip a ser arrastado (para o overlay)
  const [dragging, setDragging] = useState<{ name: string; color: string } | null>(null);

  // ── Derivados ───────────────────────────────────────────────────────────────

  // Equipa de origem (home) de cada colaboradora
  const homeTeamOf = useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of allocated) {
      for (const m of team.members) map[m.id] = team.id;
    }
    return map;
  }, [allocated]);

  // Lista completa de colaboradoras (id → dados)
  const allMembers = useMemo(() => {
    const map: Record<string, Member> = {};
    for (const team of allocated) {
      for (const m of team.members) map[m.id] = m;
    }
    return map;
  }, [allocated]);

  // Equipa efetiva (override ou origem)
  function effectiveTeamId(collaboratorId: string): string | undefined {
    return overrideMap[collaboratorId] ?? homeTeamOf[collaboratorId];
  }

  // Membros efetivos (que trabalham hoje) por equipa
  const membersByTeam = useMemo(() => {
    const map: Record<string, Member[]> = {};
    for (const team of allocated) map[team.id] = [];
    for (const id of Object.keys(allMembers)) {
      const eff = overrideMap[id] ?? homeTeamOf[id];
      if (eff && map[eff]) map[eff].push(allMembers[id]);
    }
    for (const id of Object.keys(map)) {
      map[id].sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    return map;
  }, [allocated, allMembers, overrideMap, homeTeamOf]);

  // ── Fetch de dados ao abrir o modal ────────────────────────────────────────

  async function fetchData() {
    setLoading(true);
    setMessage(null);

    const dateStr = format(selectedDate, "yyyy-MM-dd");

    const [
      { data: teamsData },
      { data: membersData },
      { data: allProfiles },
      { data: absencesData },
      { data: vehiclesData },
    ] = await Promise.all([
      supabase
        .from("teams")
        .select("id, name, color")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),

      supabase
        .from("team_members")
        .select("team_id, collaborator_id, profiles(id, full_name, avatar_url)")
        .in("team_id", teams.map((t) => t.id))
        .is("left_at", null),

      supabase
        .from("profiles")
        .select("id, full_name, avatar_url")
        .eq("company_id", companyId)
        .eq("role", "colaborador")
        .eq("status", "ativo")
        .order("full_name"),

      supabase
        .from("absences")
        .select("collaborator_id, absence_type, profiles(id, full_name, avatar_url)")
        .eq("company_id", companyId)
        .lte("starts_on", dateStr)
        .gte("ends_on", dateStr),

      // Viaturas ativas da empresa
      supabase
        .from("vehicles")
        .select("id, model, plate")
        .eq("company_id", companyId)
        .eq("status", "ativo")
        .order("model"),
    ]);

    const absentIds = new Set((absencesData ?? []).map((a) => a.collaborator_id));
    const inTeamIds = new Set((membersData ?? []).map((m) => m.collaborator_id));

    const allocatedTeams: TeamWithMembers[] = (teamsData ?? [])
      .map((t) => {
        const teamMemberRows = (membersData ?? []).filter((m) => m.team_id === t.id);
        const members: Member[] = teamMemberRows
          .map((m) => {
            const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
            return p ? { id: p.id, full_name: p.full_name, avatar_url: p.avatar_url } : null;
          })
          .filter((m): m is Member => m !== null);
        return { id: t.id, name: t.name, color: t.color, members };
      })
      // Ordenação numérica natural: "Equipa 1, 2, 3, 10, 11" (não "1, 10, 11, 2")
      .sort((a, b) => a.name.localeCompare(b.name, "pt", { numeric: true, sensitivity: "base" }));

    const availableProfiles: Member[] = (allProfiles ?? [])
      .filter((p) => !inTeamIds.has(p.id) && !absentIds.has(p.id))
      .map((p) => ({ id: p.id, full_name: p.full_name, avatar_url: p.avatar_url }));

    const absentProfiles: AbsentCollaborator[] = (absencesData ?? [])
      .map((a) => {
        const p = Array.isArray(a.profiles) ? a.profiles[0] : a.profiles;
        return p
          ? { id: p.id, full_name: p.full_name, avatar_url: p.avatar_url, absence_type: a.absence_type }
          : null;
      })
      .filter((a): a is AbsentCollaborator => a !== null);

    setAllocated(allocatedTeams);
    setAvailable(availableProfiles);
    setAbsent(absentProfiles);
    setVehicles((vehiclesData ?? []) as VehicleOption[]);

    // Carregar alocações de viatura para o dia.
    try {
      const existingAllocations = await getAllocationsForDate(dateStr);
      const map: Record<string, TeamAllocation> = {};
      for (const alloc of existingAllocations as VehicleAllocation[]) {
        map[alloc.team_id] = {
          vehicleId: alloc.vehicle_id,
          driverId:  alloc.driver_id ?? "",
        };
      }
      setAllocationMap(map);

      // As reatribuições de equipa passaram a ser PERMANENTES (escritas em
      // team_members), por isso já não se usam overrides diários: a composição
      // vem toda de team_members (allocated). Mantém o mapa vazio.
      setOverrideMap({});
    } catch {
      // não bloquear se falhar
    }

    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedDate]);

  // ── Handlers de alocação ────────────────────────────────────────────────────

  function handleVehicleChange(teamId: string, vehicleId: string) {
    setAllocationMap((prev) => ({
      ...prev,
      [teamId]: { vehicleId, driverId: prev[teamId]?.driverId ?? "" },
    }));
  }

  function handleDriverChange(teamId: string, driverId: string) {
    setAllocationMap((prev) => ({
      ...prev,
      [teamId]: { vehicleId: prev[teamId]?.vehicleId ?? "", driverId },
    }));
  }

  // ── Drag & drop de colaboradoras entre equipas ──────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as
      | { collaboratorId: string; fromTeamId: string; fullName: string }
      | undefined;
    if (!data) return;
    const color = allocated.find((t) => t.id === data.fromTeamId)?.color ?? "#16A34A";
    setDragging({ name: data.fullName, color });
    setMessage(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over || !active.data.current) return;

    const { collaboratorId } = active.data.current as { collaboratorId: string };
    const targetTeamId = over.id as string;
    const currentTeamId = effectiveTeamId(collaboratorId);
    if (!targetTeamId || targetTeamId === currentTeamId) return;

    const homeTeamId = homeTeamOf[collaboratorId] ?? null;
    const isReset = homeTeamId !== null && targetTeamId === homeTeamId;

    const dateStr = format(selectedDate, "yyyy-MM-dd");
    const previous = { ...overrideMap };

    // Atualização otimista (sem delay)
    setOverrideMap((prev) => {
      const next = { ...prev };
      if (isReset) delete next[collaboratorId];
      else next[collaboratorId] = targetTeamId;
      return next;
    });

    try {
      const res = await moveCollaboratorToTeam({
        collaboratorId,
        teamId: targetTeamId,
        homeTeamId,
        date: dateStr,
      });

      if (!res.ok) {
        setOverrideMap(previous);
        setMessage({ type: "error", text: res.error ?? "Erro ao mover colaboradora." });
        return;
      }

      const name = allMembers[collaboratorId]?.full_name.split(" ")[0] ?? "Colaboradora";
      const targetName = allocated.find((t) => t.id === targetTeamId)?.name ?? "equipa";
      setMessage({
        type: res.notified ? "success" : "info",
        text: `${name} → ${targetName} (equipa permanente).${res.notified ? " Avisada no telemóvel." : ""}`,
      });
      // Movimento permanente: recarrega a composição real das equipas (team_members)
      // para refletir a mudança e limpar marcadores de override.
      await fetchData();
    } catch {
      setOverrideMap(previous);
      setMessage({ type: "error", text: "Erro ao mover colaboradora." });
    }
  }

  // ── Guardar alocações de viatura ────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const dateStr = format(selectedDate, "yyyy-MM-dd");

    try {
      await Promise.all(
        allocated.map((team) => {
          const alloc = allocationMap[team.id];
          if (!alloc?.vehicleId) {
            return removeAllocation(team.id, dateStr).catch(() => null);
          }
          return upsertAllocation({
            vehicle_id: alloc.vehicleId,
            team_id:    team.id,
            driver_id:  alloc.driverId || null,
            date:       dateStr,
          });
        }),
      );
      setMessage({ type: "success", text: "Alocações guardadas." });
      setTimeout(onClose, 1200);
    } catch {
      setMessage({ type: "error", text: "Erro ao guardar alocações." });
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const dateLabel = format(selectedDate, "EEEE, d 'de' MMMM", { locale: pt });

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] shrink-0">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Alocação de equipas</h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 capitalize">{dateLabel}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchData}
                disabled={loading}
                title="Atualizar"
                className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Conteúdo */}
          <div className="flex-1 overflow-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--color-primary)]" />
              </div>
            ) : (
              <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  {/* Coluna esquerda — EQUIPAS */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                      Equipas ({allocated.length})
                    </h3>
                    <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                      Arrasta uma colaboradora para outra equipa — a mudança é permanente (afeta também a aba Equipas) e ela é avisada no telemóvel.
                    </p>
                    <div className="space-y-3">
                      {allocated.length === 0 && (
                        <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">
                          Sem equipas configuradas.
                        </p>
                      )}
                      {allocated.map((team) => {
                        const alloc = allocationMap[team.id];
                        const selectedVehicleId = alloc?.vehicleId ?? "";
                        const selectedDriverId  = alloc?.driverId  ?? "";
                        const teamMembers = membersByTeam[team.id] ?? [];

                        return (
                          <DroppableColumn
                            key={team.id}
                            id={team.id}
                            className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]"
                          >
                            {/* Nome da equipa */}
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: team.color }} />
                              <span className="text-sm font-semibold text-[var(--color-text-main)]">{team.name}</span>
                            </div>

                            {/* Membros (arrastáveis) */}
                            <div className="flex flex-wrap gap-1.5 mb-3 min-h-[26px]">
                              {teamMembers.length === 0 ? (
                                <span className="text-xs text-[var(--color-text-muted)]">Largar aqui</span>
                              ) : (
                                teamMembers.map((m) => (
                                  <MemberChip
                                    key={m.id}
                                    member={m}
                                    color={team.color}
                                    fromTeamId={team.id}
                                    moved={(overrideMap[m.id] ?? homeTeamOf[m.id]) !== homeTeamOf[m.id]}
                                  />
                                ))
                              )}
                            </div>

                            {/* Viatura */}
                            <div className="space-y-2">
                              <div className="relative">
                                <Car className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                <select
                                  value={selectedVehicleId}
                                  onChange={(e) => handleVehicleChange(team.id, e.target.value)}
                                  className="w-full appearance-none pl-8 pr-8 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                                >
                                  <option value="">Sem viatura</option>
                                  {vehicles.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {v.model} — {v.plate}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                              </div>

                              {/* Condutor — só mostra se houver viatura selecionada */}
                              {selectedVehicleId && (
                                <div className="relative">
                                  <User className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                  <select
                                    value={selectedDriverId}
                                    onChange={(e) => handleDriverChange(team.id, e.target.value)}
                                    className="w-full appearance-none pl-8 pr-8 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                                  >
                                    <option value="">Sem condutor definido</option>
                                    {teamMembers.map((m) => (
                                      <option key={m.id} value={m.id}>{m.full_name}</option>
                                    ))}
                                  </select>
                                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                </div>
                              )}
                            </div>
                          </DroppableColumn>
                        );
                      })}
                    </div>

                    {/* Aviso se não há viaturas */}
                    {vehicles.length === 0 && (
                      <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
                        Sem viaturas ativas. Adiciona em <strong>Viaturas</strong> na sidebar.
                      </div>
                    )}
                  </div>

                  {/* Coluna direita */}
                  <div className="space-y-5">
                    {/* DISPONÍVEL */}
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
                        Disponível ({available.length})
                      </h3>
                      {available.length === 0 ? (
                        <p className="text-sm text-[var(--color-text-muted)] py-3 text-center">
                          Todas as colaboradoras têm equipa.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {available.map((m) => (
                            <div key={m.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-100">
                              <div className="w-6 h-6 rounded-full bg-green-200 flex items-center justify-center text-xs font-bold text-green-700 shrink-0">
                                {m.full_name.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-sm text-[var(--color-text-main)]">{m.full_name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* AUSENTES */}
                    {absent.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
                          Ausentes ({absent.length})
                        </h3>
                        <div className="space-y-1.5">
                          {absent.map((m) => (
                            <div key={m.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100">
                              <div className="w-6 h-6 rounded-full bg-red-200 flex items-center justify-center text-xs font-bold text-red-700 shrink-0">
                                {m.full_name.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-sm text-[var(--color-text-main)] flex-1">{m.full_name}</span>
                              <span className="text-xs text-red-600 font-medium shrink-0">
                                {ABSENCE_LABELS[m.absence_type] ?? m.absence_type}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <DragOverlay dropAnimation={null}>
                  {dragging ? (
                    <span
                      className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-xs font-medium text-white shadow-lg"
                      style={{ backgroundColor: dragging.color }}
                    >
                      <GripVertical className="w-3 h-3 opacity-70 shrink-0" />
                      {dragging.name.split(" ")[0]}
                    </span>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--color-border)] px-6 py-4 flex items-center gap-3 shrink-0">
            {message && (
              <span className={`text-sm flex-1 ${
                message.type === "error" ? "text-red-600"
                : message.type === "info" ? "text-[var(--color-text-sub)]"
                : "text-[var(--color-primary)]"
              }`}>
                {message.text}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Fechar
              </button>
              <button
                onClick={handleSave}
                disabled={saving || loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Guardar alocações
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
