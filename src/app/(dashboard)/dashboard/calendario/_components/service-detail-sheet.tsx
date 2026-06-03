"use client";

import { useState, useEffect } from "react";
import {
  X, MapPin, Users, Clock, Euro, FileText, Loader2,
  AlertTriangle, Ban, CalendarX, CheckCircle2, ChevronDown,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Timesheet = Database["public"]["Tables"]["timesheets"]["Row"] & {
  profiles?: { full_name: string } | null;
};

// ─── Estilos de estado ────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; text: string; border: string; label: string }> = {
  agendado:  { bg: "#F0FDF4", text: "#15803D", border: "#BBF7D0", label: "Agendado" },
  em_curso:  { bg: "#FFFBEB", text: "#92400E", border: "#FDE68A", label: "Em curso" },
  concluido: { bg: "#F8FAFC", text: "#475569", border: "#E2E8F0", label: "Concluído" },
  cancelado: { bg: "#FEF2F2", text: "#B91C1C", border: "#FECACA", label: "Cancelado" },
  falta:     { bg: "#FEF2F2", text: "#B91C1C", border: "#FECACA", label: "Falta" },
};

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  service: ServiceFull | null;
  onClose: () => void;
  onChanged: () => void;
}

export function ServiceDetailSheet({ service, onClose, onChanged }: Props) {
  const supabase = createClient();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loadingTs, setLoadingTs] = useState(false);

  // Estado para corrigir clock-out
  const [fixClockOut, setFixClockOut] = useState(false);
  const [clockOutTime, setClockOutTime] = useState("");
  const [clockOutServiceId, setClockOutServiceId] = useState<string | null>(null);

  // Estado para loading de actions
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // Buscar timesheets quando o serviço muda
  useEffect(() => {
    if (!service) { setTimesheets([]); return; }
    setTimesheets([]);
    setActionMsg(null);
    setFixClockOut(false);
    setLoadingTs(true);
    supabase
      .from("timesheets")
      .select("*, profiles:collaborator_id ( full_name )")
      .eq("service_id", service.id)
      .then(({ data }) => {
        setTimesheets((data as Timesheet[]) ?? []);
        setLoadingTs(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id]);

  if (!service) return null;

  const ss = STATUS_STYLE[service.status] ?? STATUS_STYLE.agendado;
  const value = service.manual_value ?? service.calculated_value;
  const canAct = service.status !== "concluido";

  // ─── Acções ──────────────────────────────────────────────────────────────

  async function doAction(action: "cancelar" | "falta" | "fixClockOut") {
    setActionLoading(action);
    setActionMsg(null);

    if (action === "cancelar") {
      const { error } = await supabase
        .from("services")
        .update({ status: "cancelado" })
        .eq("id", service.id);
      if (error) { setActionMsg({ type: "error", text: error.message }); }
      else { setActionMsg({ type: "success", text: "Serviço cancelado." }); onChanged(); }

    } else if (action === "falta") {
      const { error } = await supabase
        .from("services")
        .update({ status: "falta" })
        .eq("id", service.id);
      if (error) { setActionMsg({ type: "error", text: error.message }); }
      else { setActionMsg({ type: "success", text: "Marcado como falta." }); onChanged(); }

    } else if (action === "fixClockOut") {
      if (!clockOutTime || !clockOutServiceId) {
        setActionMsg({ type: "error", text: "Seleciona uma colaboradora e insere a hora." });
        setActionLoading(null);
        return;
      }
      const dateStr = format(parseISO(service.scheduled_start), "yyyy-MM-dd");
      const clockOutISO = `${dateStr}T${clockOutTime}:00`;

      // Calcular duração em minutos
      const tsRow = timesheets.find((t) => t.id === clockOutServiceId);
      let durationMinutes: number | null = null;
      if (tsRow?.clock_in_at) {
        const inMs = new Date(tsRow.clock_in_at).getTime();
        const outMs = new Date(clockOutISO).getTime();
        durationMinutes = Math.round((outMs - inMs) / 60000);
      }

      const { error } = await supabase
        .from("timesheets")
        .update({
          clock_out_at: clockOutISO,
          duration_minutes: durationMinutes,
          notes: "Hora de saída corrigida manualmente pelo gestor",
        })
        .eq("id", clockOutServiceId);

      if (error) { setActionMsg({ type: "error", text: error.message }); }
      else {
        setActionMsg({ type: "success", text: "Hora de saída corrigida." });
        setFixClockOut(false);
        // Re-fetch timesheets
        const { data } = await supabase
          .from("timesheets")
          .select("*, profiles:collaborator_id ( full_name )")
          .eq("service_id", service.id);
        setTimesheets((data as Timesheet[]) ?? []);
        onChanged();
      }
    }

    setActionLoading(null);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs text-[var(--color-text-muted)]">#{service.reference_number}</span>
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: ss.bg, color: ss.text, border: `1px solid ${ss.border}` }}
              >
                {ss.label}
              </span>
            </div>
            <h2 className="text-base font-bold text-[var(--color-text-main)] truncate">
              {service.location_name}
            </h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">{service.client_name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 ml-3 shrink-0 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* Info principal */}
          <div className="space-y-3">
            <InfoRow icon={Clock} label="Horário">
              <span className="font-semibold">
                {format(parseISO(service.scheduled_start), "HH:mm")} –{" "}
                {format(parseISO(service.scheduled_end), "HH:mm")}
              </span>
              <span className="text-[var(--color-text-muted)] ml-1.5">
                {format(parseISO(service.scheduled_start), "EEEE, d 'de' MMMM", { locale: pt })}
              </span>
            </InfoRow>

            <InfoRow icon={MapPin} label="Morada">
              {service.location_address}
            </InfoRow>

            {service.team_name && (
              <InfoRow icon={Users} label="Equipa">
                <div className="flex items-center gap-1.5">
                  {service.team_color && (
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: service.team_color }}
                    />
                  )}
                  {service.team_name}
                </div>
              </InfoRow>
            )}

            {value != null && (
              <InfoRow icon={Euro} label="Valor">
                <span className="font-semibold">€{value.toFixed(2)}</span>
                {service.manual_value != null && service.calculated_value != null && (
                  <span className="text-xs text-[var(--color-text-muted)] ml-1.5">
                    (manual · calculado: €{service.calculated_value.toFixed(2)})
                  </span>
                )}
              </InfoRow>
            )}

            {service.notes && (
              <InfoRow icon={FileText} label="Notas">
                <p className="text-sm text-[var(--color-text-sub)] whitespace-pre-line">{service.notes}</p>
              </InfoRow>
            )}
          </div>

          {/* Tempos reais (actual_start / actual_end) */}
          {(service.actual_start || service.actual_end) && (
            <div className="p-3 rounded-lg bg-[var(--color-primary-light)] border border-[var(--color-primary-muted)]">
              <p className="text-xs font-semibold text-[var(--color-primary)] mb-1.5">Tempo real</p>
              <div className="flex gap-4 text-sm text-[var(--color-primary)]">
                {service.actual_start && (
                  <span>Entrada: <strong>{format(parseISO(service.actual_start), "HH:mm")}</strong></span>
                )}
                {service.actual_end && (
                  <span>Saída: <strong>{format(parseISO(service.actual_end), "HH:mm")}</strong></span>
                )}
              </div>
            </div>
          )}

          {/* Clock-ins das colaboradoras */}
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)] mb-2">Presenças</p>
            {loadingTs ? (
              <div className="flex items-center gap-2 py-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" /> A carregar...
              </div>
            ) : timesheets.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] py-2">Sem registos de ponto.</p>
            ) : (
              <div className="space-y-2">
                {timesheets.map((ts) => (
                  <TimesheetRow key={ts.id} ts={ts} />
                ))}
              </div>
            )}
          </div>

          {/* Corrigir clock-out */}
          {fixClockOut && timesheets.length > 0 && (
            <div className="p-4 rounded-lg border border-[var(--color-border)] space-y-3">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Corrigir hora de saída</p>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Colaboradora</label>
                <div className="relative">
                  <select
                    value={clockOutServiceId ?? ""}
                    onChange={(e) => setClockOutServiceId(e.target.value)}
                    className={INPUT_CLS + " pr-8 appearance-none"}
                  >
                    <option value="">Selecionar...</option>
                    {timesheets.map((ts) => (
                      <option key={ts.id} value={ts.id}>
                        {(ts.profiles as { full_name: string } | null)?.full_name ?? ts.collaborator_id}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Nova hora de saída</label>
                <input
                  type="time"
                  value={clockOutTime}
                  onChange={(e) => setClockOutTime(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => doAction("fixClockOut")}
                  disabled={actionLoading === "fixClockOut"}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
                >
                  {actionLoading === "fixClockOut" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Guardar
                </button>
                <button
                  onClick={() => setFixClockOut(false)}
                  className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* Feedback */}
          {actionMsg && (
            <div
              className={`text-sm px-3 py-2 rounded-lg border ${
                actionMsg.type === "error"
                  ? "bg-red-50 text-red-700 border-red-100"
                  : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border-[var(--color-primary-muted)]"
              }`}
            >
              {actionMsg.text}
            </div>
          )}
        </div>

        {/* Footer — acções */}
        {canAct && (
          <div className="border-t border-[var(--color-border)] px-6 py-4 space-y-2">
            {/* Corrigir clock-out — só se houver timesheets sem clock-out */}
            {timesheets.some((t) => t.clock_in_at && !t.clock_out_at) && !fixClockOut && (
              <button
                onClick={() => setFixClockOut(true)}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors"
              >
                <CheckCircle2 className="w-4 h-4 text-[var(--color-primary)]" />
                Corrigir hora de saída
              </button>
            )}

            {service.status !== "falta" && (
              <button
                onClick={() => doAction("falta")}
                disabled={actionLoading === "falta"}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-200 text-sm font-medium text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
              >
                {actionLoading === "falta"
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <AlertTriangle className="w-4 h-4" />
                }
                Marcar como falta
              </button>
            )}

            {service.status !== "cancelado" && (
              <button
                onClick={() => doAction("cancelar")}
                disabled={actionLoading === "cancelar"}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {actionLoading === "cancelar"
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Ban className="w-4 h-4" />
                }
                Cancelar serviço
              </button>
            )}
          </div>
        )}

        {/* Serviço concluído — sem acções */}
        {!canAct && (
          <div className="border-t border-[var(--color-border)] px-6 py-4">
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <CalendarX className="w-4 h-4" />
              Serviço concluído — sem acções disponíveis.
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center text-[var(--color-text-muted)]">
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-0.5">{label}</p>
        <div className="text-sm text-[var(--color-text-main)]">{children}</div>
      </div>
    </div>
  );
}

function TimesheetRow({ ts }: { ts: Timesheet }) {
  const name = (ts.profiles as { full_name: string } | null)?.full_name ?? "—";
  const hasWarning = ts.location_warning;

  return (
    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-[var(--color-primary)]">
            {name[0]?.toUpperCase() ?? "?"}
          </span>
        </div>
        <span className="text-sm text-[var(--color-text-main)] truncate">{name}</span>
        {hasWarning && (
          <span title="Fora do raio GPS" className="shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)] shrink-0 ml-2">
        {ts.clock_in_at ? (
          <span className="text-green-700 font-medium">
            ↑ {format(parseISO(ts.clock_in_at), "HH:mm")}
          </span>
        ) : (
          <span className="opacity-50">↑ —</span>
        )}
        {ts.clock_out_at ? (
          <span className="font-medium">
            ↓ {format(parseISO(ts.clock_out_at), "HH:mm")}
          </span>
        ) : (
          <span className="text-amber-600 font-medium">↓ em falta</span>
        )}
        {ts.duration_minutes != null && (
          <span className="bg-[var(--color-border)] px-1.5 py-0.5 rounded">
            {Math.round(ts.duration_minutes / 60 * 10) / 10}h
          </span>
        )}
      </div>
    </div>
  );
}
