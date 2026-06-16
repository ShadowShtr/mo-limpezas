"use client";

import { useState, useMemo } from "react";
import { format, isSameDay, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { ArrowRight, Download, Save, Loader2 } from "lucide-react";
import { saveActualTimes, type ServiceTimeUpdate } from "@/app/actions/timesheets";
import type { Database } from "@/types/database";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team = { id: string; name: string; color: string };

interface Props {
  services: ServiceFull[];
  teams: Team[];
  selectedDate: Date;
  onChanged: () => void;
}

// ─── Estado das células editáveis ─────────────────────────────────────────────

type EditMap = Record<string, { actual_start: string; actual_end: string }>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  agendado:      { label: "Agendado",     cls: "bg-blue-100 text-blue-700" },
  em_curso:      { label: "Em curso",     cls: "bg-amber-100 text-amber-700" },
  concluido:     { label: "Concluído",    cls: "bg-green-100 text-green-700" },
  cancelado:     { label: "Cancelado",    cls: "bg-red-100 text-red-700" },
  falta:         { label: "Falta",        cls: "bg-red-100 text-red-700" },
  sem_cobertura: { label: "Sem cobertura",cls: "bg-orange-100 text-orange-700" },
};

function tsToTime(ts: string | null): string {
  if (!ts) return "";
  try {
    return format(parseISO(ts), "HH:mm");
  } catch {
    return "";
  }
}

function buildTimestamp(dateStr: string, time: string): string | null {
  if (!time) return null;
  return `${dateStr}T${time}:00`;
}

function toCSV(rows: ServiceFull[], edits: EditMap): string {
  const headers = [
    "Referência",
    "Cliente",
    "Local",
    "Equipa",
    "Início Previsto",
    "Fim Previsto",
    "Início Real",
    "Fim Real",
    "Estado",
  ];
  const lines = [headers.join(";")];

  for (const s of rows) {
    const e = edits[s.id];
    lines.push([
      s.reference_number,
      s.client_name,
      s.location_name,
      s.team_name ?? "",
      tsToTime(s.scheduled_start),
      tsToTime(s.scheduled_end),
      e?.actual_start ?? tsToTime(s.actual_start),
      e?.actual_end   ?? tsToTime(s.actual_end),
      STATUS_LABELS[s.status]?.label ?? s.status,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"));
  }

  return lines.join("\n");
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function CalendarListView({ services, teams, selectedDate, onChanged }: Props) {
  const dateStr = format(selectedDate, "yyyy-MM-dd");

  // Filtrar serviços do dia seleccionado
  const dayServices = useMemo(
    () =>
      services
        .filter((s) => isSameDay(parseISO(s.scheduled_start), selectedDate))
        .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)),
    [services, selectedDate],
  );

  // Mapa de edições: serviceId → {actual_start, actual_end}
  const [edits, setEdits] = useState<EditMap>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function getEdit(id: string) {
    return edits[id] ?? {
      actual_start: tsToTime(dayServices.find((s) => s.id === id)?.actual_start ?? null),
      actual_end:   tsToTime(dayServices.find((s) => s.id === id)?.actual_end   ?? null),
    };
  }

  function setField(id: string, field: "actual_start" | "actual_end", value: string) {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...getEdit(id), [field]: value },
    }));
    setSaveMsg(null);
  }

  function propagate(s: ServiceFull) {
    setEdits((prev) => ({
      ...prev,
      [s.id]: {
        actual_start: tsToTime(s.scheduled_start),
        actual_end:   tsToTime(s.scheduled_end),
      },
    }));
    setSaveMsg(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);

    const updates: ServiceTimeUpdate[] = Object.entries(edits).map(([id, e]) => ({
      id,
      actual_start: buildTimestamp(dateStr, e.actual_start),
      actual_end:   buildTimestamp(dateStr, e.actual_end),
    }));

    const result = await saveActualTimes(updates);
    setSaving(false);

    if (result.ok) {
      setSaveMsg({ ok: true, text: "Guardado com sucesso." });
      setEdits({});
      onChanged();
    } else {
      setSaveMsg({ ok: false, text: result.error ?? "Erro desconhecido." });
    }
  }

  function handleExport() {
    const csv = toCSV(dayServices, edits);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `escala-${dateStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasEdits = Object.keys(edits).length > 0;
  const dateLabel = format(selectedDate, "EEEE, d 'de' MMMM yyyy", { locale: pt });

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Barra de ações */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0">
        <span className="text-sm font-medium text-[var(--color-text-main)] capitalize">{dateLabel}</span>
        <div className="flex items-center gap-2">
          {saveMsg && (
            <span className={`text-xs font-medium ${saveMsg.ok ? "text-[var(--color-primary)]" : "text-red-600"}`}>
              {saveMsg.text}
            </span>
          )}
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-xs font-semibold hover:bg-[var(--color-background)] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar CSV
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasEdits}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Guardar
          </button>
        </div>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto">
        {dayServices.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-[var(--color-text-muted)] text-sm">
            Sem serviços para este dia.
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">#Serviço</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Cliente / Local</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">Equipa</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">Iníc. Prev.</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">Fim Prev.</th>
                <th className="px-2 py-2.5 text-center text-xs font-semibold text-[var(--color-text-muted)]" title="Propagar horário previsto para o real">→</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">Início Real</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap">Fim Real</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {dayServices.map((s) => {
                const e = getEdit(s.id);
                const isEdited = !!edits[s.id];
                const statusInfo = STATUS_LABELS[s.status] ?? { label: s.status, cls: "bg-gray-100 text-gray-700" };
                const teamColor = teams.find((t) => t.id === s.team_id)?.color ?? s.team_color ?? "#94A3B8";

                return (
                  <tr
                    key={s.id}
                    className={`hover:bg-[var(--color-background)] transition-colors ${isEdited ? "bg-green-50/40" : ""}`}
                    style={{
                      borderLeft: `3px solid ${teamColor}`,
                    }}
                  >
                    {/* Referência */}
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-[var(--color-text-main)] whitespace-nowrap">
                      {s.reference_number}
                    </td>

                    {/* Cliente / Local */}
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-[var(--color-text-main)] truncate max-w-[200px]">{s.client_name}</div>
                      <div className="text-xs text-[var(--color-text-muted)] truncate max-w-[200px]">{s.location_name}</div>
                    </td>

                    {/* Equipa */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {s.team_name ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white"
                          style={{ backgroundColor: teamColor }}
                        >
                          {s.team_name}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-text-muted)]">—</span>
                      )}
                    </td>

                    {/* Início Previsto */}
                    <td className="px-4 py-2.5 tabular-nums text-[var(--color-text-sub)] whitespace-nowrap">
                      {tsToTime(s.scheduled_start)}
                    </td>

                    {/* Fim Previsto */}
                    <td className="px-4 py-2.5 tabular-nums text-[var(--color-text-sub)] whitespace-nowrap">
                      {tsToTime(s.scheduled_end)}
                    </td>

                    {/* Propagar → */}
                    <td className="px-2 py-2.5 text-center">
                      <button
                        onClick={() => propagate(s)}
                        title="Copiar horário previsto para o real"
                        className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </td>

                    {/* Início Real */}
                    <td className="px-4 py-2.5">
                      <input
                        type="time"
                        value={e.actual_start}
                        onChange={(ev) => setField(s.id, "actual_start", ev.target.value)}
                        className="w-24 px-2 py-1 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                      />
                    </td>

                    {/* Fim Real */}
                    <td className="px-4 py-2.5">
                      <input
                        type="time"
                        value={e.actual_end}
                        onChange={(ev) => setField(s.id, "actual_end", ev.target.value)}
                        className="w-24 px-2 py-1 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                      />
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${statusInfo.cls}`}>
                        {statusInfo.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
