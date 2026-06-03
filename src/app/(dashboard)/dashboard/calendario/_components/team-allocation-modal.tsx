"use client";

import { useState, useEffect } from "react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { X, Loader2, Car, RefreshCw, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// ─── Constantes ───────────────────────────────────────────────────────────────

const VEHICLE_OPTS = [
  { value: "", label: "Sem viatura" },
  { value: "Opel Vivaro", label: "Opel Vivaro" },
  { value: "Citroën Berlingo", label: "Citroën Berlingo" },
  { value: "Ford Transit", label: "Ford Transit" },
  { value: "Renault Trafic", label: "Renault Trafic" },
  { value: "Volkswagen Transporter", label: "VW Transporter" },
  { value: "Próprio", label: "Próprio" },
  { value: "Outro", label: "Outro" },
];

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa: "Baixa médica",
  doenca_sem_baixa: "Doença",
  pessoal_justificado: "Pessoal just.",
  pessoal_injustificado: "Pessoal injust.",
  ferias: "Férias",
  feriado: "Feriado",
  formacao: "Formação",
  outro: "Outro",
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
  vehicle: string;
  members: Member[];
}

interface AbsentCollaborator extends Member {
  absence_type: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  selectedDate: Date;
  teams: TeamBase[];
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function TeamAllocationModal({
  open, onClose, companyId, selectedDate, teams,
}: Props) {
  const supabase = createClient();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [allocated, setAllocated] = useState<TeamWithMembers[]>([]);
  const [available, setAvailable] = useState<Member[]>([]);
  const [absent, setAbsent] = useState<AbsentCollaborator[]>([]);

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
    ] = await Promise.all([
      // Teams com vehicle
      supabase
        .from("teams")
        .select("id, name, color, vehicle")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),

      // Membros activos de cada equipa (com dados do perfil)
      supabase
        .from("team_members")
        .select("team_id, collaborator_id, profiles(id, full_name, avatar_url)")
        .in("team_id", teams.map((t) => t.id))
        .is("left_at", null),

      // Todos os colaboradores da empresa
      supabase
        .from("profiles")
        .select("id, full_name, avatar_url")
        .eq("company_id", companyId)
        .eq("role", "colaborador")
        .eq("status", "ativo")
        .order("full_name"),

      // Ausências que cobrem o dia seleccionado
      supabase
        .from("absences")
        .select("collaborator_id, absence_type, profiles(id, full_name, avatar_url)")
        .eq("company_id", companyId)
        .lte("starts_on", dateStr)
        .gte("ends_on", dateStr),
    ]);

    // IDs com ausência hoje
    const absentIds = new Set((absencesData ?? []).map((a) => a.collaborator_id));

    // IDs em alguma equipa activa
    const inTeamIds = new Set((membersData ?? []).map((m) => m.collaborator_id));

    // ALOCADAS — equipas com os seus membros e viatura atual
    const allocatedTeams: TeamWithMembers[] = (teamsData ?? []).map((t) => {
      const teamMemberRows = (membersData ?? []).filter((m) => m.team_id === t.id);
      const members: Member[] = teamMemberRows
        .map((m) => {
          const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
          return p ? { id: p.id, full_name: p.full_name, avatar_url: p.avatar_url } : null;
        })
        .filter((m): m is Member => m !== null);
      return {
        id: t.id,
        name: t.name,
        color: t.color,
        vehicle: t.vehicle ?? "",
        members,
      };
    });

    // DISPONÍVEL — colaboradores sem equipa E sem ausência hoje
    const availableProfiles: Member[] = (allProfiles ?? []).filter(
      (p) => !inTeamIds.has(p.id) && !absentIds.has(p.id),
    ).map((p) => ({ id: p.id, full_name: p.full_name, avatar_url: p.avatar_url }));

    // AUSENTES — colaboradores com ausência registada hoje
    const absentProfiles: AbsentCollaborator[] = (absencesData ?? []).map((a) => {
      const p = Array.isArray(a.profiles) ? a.profiles[0] : a.profiles;
      return p
        ? { id: p.id, full_name: p.full_name, avatar_url: p.avatar_url, absence_type: a.absence_type }
        : null;
    }).filter((a): a is AbsentCollaborator => a !== null);

    setAllocated(allocatedTeams);
    setAvailable(availableProfiles);
    setAbsent(absentProfiles);
    setLoading(false);
  }

  useEffect(() => {
    if (open) fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedDate]);

  // ── Actualizar viatura de uma equipa ──────────────────────────────────────

  function handleVehicleChange(teamId: string, vehicle: string) {
    setAllocated((prev) =>
      prev.map((t) => (t.id === teamId ? { ...t, vehicle } : t)),
    );
  }

  // ── Guardar ───────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const updates = allocated.map((t) =>
      supabase.from("teams").update({ vehicle: t.vehicle || null }).eq("id", t.id),
    );

    const results = await Promise.all(updates);
    const errors = results.filter((r) => r.error);

    setSaving(false);
    if (errors.length > 0) {
      setMessage({ type: "error", text: "Erro ao guardar algumas viaturas." });
    } else {
      setMessage({ type: "success", text: "Viaturas guardadas." });
      setTimeout(onClose, 1200);
    }
  }

  if (!open) return null;

  const dateLabel = format(selectedDate, "EEEE, d 'de' MMMM", { locale: pt });

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] shrink-0">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                Alocação de equipas
              </h2>
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Coluna esquerda — ALOCADAS */}
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
                    Equipas alocadas ({allocated.length})
                  </h3>
                  <div className="space-y-3">
                    {allocated.length === 0 && (
                      <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">
                        Sem equipas configuradas.
                      </p>
                    )}
                    {allocated.map((team) => (
                      <div
                        key={team.id}
                        className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]"
                      >
                        {/* Nome da equipa */}
                        <div className="flex items-center gap-2 mb-3">
                          <div
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: team.color }}
                          />
                          <span className="text-sm font-semibold text-[var(--color-text-main)]">
                            {team.name}
                          </span>
                        </div>

                        {/* Membros */}
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {team.members.length === 0 ? (
                            <span className="text-xs text-[var(--color-text-muted)]">Sem membros</span>
                          ) : (
                            team.members.map((m) => (
                              <span
                                key={m.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                                style={{ backgroundColor: team.color }}
                                title={m.full_name}
                              >
                                {m.full_name.split(" ")[0]}
                              </span>
                            ))
                          )}
                        </div>

                        {/* Viatura */}
                        <div className="relative">
                          <Car className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                          <select
                            value={team.vehicle}
                            onChange={(e) => handleVehicleChange(team.id, e.target.value)}
                            className="w-full appearance-none pl-8 pr-8 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                          >
                            {VEHICLE_OPTS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                        </div>
                      </div>
                    ))}
                  </div>
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
                          <div
                            key={m.id}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-100"
                          >
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
                          <div
                            key={m.id}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100"
                          >
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
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--color-border)] px-6 py-4 flex items-center gap-3 shrink-0">
            {message && (
              <span className={`text-sm ${message.type === "error" ? "text-red-600" : "text-[var(--color-primary)]"} flex-1`}>
                {message.text}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving || loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Guardar viaturas
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
