"use client";

import { useState, useEffect, useMemo } from "react";
import {
  X, MapPin, Users, Clock, Euro, FileText, Loader2,
  AlertTriangle, Ban, CalendarX, CheckCircle2, ChevronDown, Bell, MessageCircle, Mail, Users2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { notifyTeam } from "@/app/actions/notifications";
import { cancelService } from "@/app/actions/cancellations";
import { CANCEL_TYPE_LABELS, type CancelType } from "@/lib/cancel-types";
import { sendBulkClientNotifications } from "@/app/actions/email";
import type { Database } from "@/types/database";

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
// Usar só os campos base do timesheet, sem join (o FK para profiles não está mapeado no tipo)
type Timesheet = Database["public"]["Tables"]["timesheets"]["Row"];

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTimesheets(supabase: ReturnType<typeof createClient>, serviceId: string): Promise<Timesheet[]> {
  const { data } = await supabase
    .from("timesheets")
    .select("*")
    .eq("service_id", serviceId)
    .order("clock_in_at");
  return (data ?? []) as Timesheet[];
}

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  service: ServiceFull | null;
  onClose: () => void;
  onChanged: () => void;
}

export function ServiceDetailSheet({ service, onClose, onChanged }: Props) {
  const supabase = createClient();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loadingTs,  setLoadingTs]  = useState(false);
  const [fixClockOut, setFixClockOut] = useState(false);
  const [clockOutTime, setClockOutTime] = useState("");
  const [clockOutTsId, setClockOutTsId] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [showNotify, setShowNotify] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState("");
  const [notifyTab, setNotifyTab] = useState<"whatsapp" | "email" | "team">("whatsapp");

  // Cancelamento
  const [showCancel, setShowCancel] = useState(false);
  const [cancelType, setCancelType] = useState<CancelType>("client_request");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotifyTeam, setCancelNotifyTeam] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!service) { setTimesheets([]); return; }
    setTimesheets([]);
    setActionMsg(null);
    setFixClockOut(false);
    setClockOutTime("");
    setClockOutTsId("");
    setShowNotify(false);
    setNotifyTab("whatsapp");
    setShowCancel(false);
    setCancelType("client_request");
    setCancelReason("");
    setCancelNotifyTeam(true);
    setNotifyMsg(
      `Serviço ${service.location_name} — ${format(parseISO(service.scheduled_start), "HH:mm")}–${format(parseISO(service.scheduled_end), "HH:mm")}`
    );
    setLoadingTs(true);
    fetchTimesheets(supabase, service.id).then((rows) => {
      setTimesheets(rows);
      setLoadingTs(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id]);

  // Calcular antes do early return (regras de hooks)
  const isLateCancelWarning = useMemo(() => {
    if (!service) return false;
    // eslint-disable-next-line react-hooks/purity
    const ms = new Date(service.scheduled_start).getTime() - Date.now();
    return ms > 0 && ms < 86_400_000;
  }, [service]);

  if (!service) return null;

  // Capturar em const para que o TypeScript saiba que não é null dentro das closures
  const svc = service;
  const ss   = STATUS_STYLE[svc.status] ?? STATUS_STYLE.agendado;
  const value = svc.manual_value ?? svc.calculated_value;
  const canAct = svc.status !== "concluido";
  // client_phone / client_email adicionados nas migrations 020/021 — cast até tipos serem regenerados
  type SvcExtra = ServiceFull & { client_phone?: string | null; client_email?: string | null };
  const clientPhone = (svc as SvcExtra).client_phone ?? null;
  const clientEmail = (svc as SvcExtra).client_email ?? null;

  // ─── Acções ──────────────────────────────────────────────────────────────

  async function doAction(action: "falta" | "fixClockOut") {
    setActionLoading(action);
    setActionMsg(null);

    if (action === "falta") {
      const { error } = await supabase
        .from("services").update({ status: "falta" }).eq("id", svc.id);
      if (error) setActionMsg({ type: "error", text: error.message });
      else { setActionMsg({ type: "success", text: "Marcado como falta." }); onChanged(); }

    } else if (action === "fixClockOut") {
      if (!clockOutTime || !clockOutTsId) {
        setActionMsg({ type: "error", text: "Seleciona uma colaboradora e insere a hora." });
        setActionLoading(null);
        return;
      }
      const dateStr    = format(parseISO(svc.scheduled_start), "yyyy-MM-dd");
      const clockOutISO = `${dateStr}T${clockOutTime}:00`;
      const tsRow      = timesheets.find((t) => t.id === clockOutTsId);
      const durationMinutes = tsRow?.clock_in_at
        ? Math.round((new Date(clockOutISO).getTime() - new Date(tsRow.clock_in_at).getTime()) / 60000)
        : null;

      const { error } = await supabase.from("timesheets").update({
        clock_out_at: clockOutISO,
        duration_minutes: durationMinutes,
        notes: "Hora de saída corrigida manualmente pelo gestor",
      }).eq("id", clockOutTsId);

      if (error) setActionMsg({ type: "error", text: error.message });
      else {
        setActionMsg({ type: "success", text: "Hora de saída corrigida." });
        setFixClockOut(false);
        setTimesheets(await fetchTimesheets(supabase, svc.id));
        onChanged();
      }
    }

    setActionLoading(null);
  }

  async function handleCancel() {
    setActionLoading("cancelar");
    setActionMsg(null);
    const res = await cancelService(svc.id, cancelType, cancelReason, cancelNotifyTeam);
    setActionLoading(null);
    if (!res.ok) {
      setActionMsg({ type: "error", text: res.error ?? "Erro ao cancelar." });
      return;
    }
    setShowCancel(false);
    const parts = ["Serviço cancelado."];
    if (res.isLate) parts.push("⚠️ Cancelamento tardio (menos de 24h de antecedência).");
    if (res.sent) parts.push(`Equipa notificada (${res.sent} membro${res.sent !== 1 ? "s" : ""}).`);
    setActionMsg({ type: "success", text: parts.join(" ") });
    onChanged();
  }

  async function handleNotifyEmail() {
    if (!clientEmail) return;
    setActionLoading("notify");
    setActionMsg(null);
    try {
      const result = await sendBulkClientNotifications([{
        serviceId:   svc.id,
        clientId:    svc.client_id,
        clientName:  svc.client_name,
        serviceDate: format(parseISO(svc.scheduled_start), "d MMM", { locale: pt }),
        serviceTime: format(parseISO(svc.scheduled_start), "HH:mm"),
        method:      "email",
        contact:     clientEmail,
      }]);
      setShowNotify(false);
      if (result.sent > 0) {
        setActionMsg({ type: "success", text: `Email enviado para ${clientEmail}.` });
      } else {
        const detail = result.errors[0] ?? "Erro desconhecido";
        setActionMsg({ type: "error", text: `Falha: ${detail}` });
      }
    } catch (err) {
      setActionMsg({ type: "error", text: err instanceof Error ? err.message : "Erro ao enviar email." });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleNotifyTeam() {
    if (!notifyMsg.trim()) return;
    setActionLoading("notify");
    setActionMsg(null);
    try {
      const res = await notifyTeam(svc.id, notifyMsg.trim());
      setShowNotify(false);
      if (res.ok) {
        setActionMsg({
          type: "success",
          text: res.sent > 0
            ? `Push enviado para ${res.sent} membro${res.sent !== 1 ? "s" : ""} da equipa.`
            : "Nenhum membro com notificações push ativas.",
        });
      } else {
        setActionMsg({ type: "error", text: res.error });
      }
    } catch (err) {
      setActionMsg({ type: "error", text: err instanceof Error ? err.message : "Erro ao notificar equipa." });
    } finally {
      setActionLoading(null);
    }
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
              <span className="font-mono text-xs text-[var(--color-text-muted)]">#{svc.reference_number}</span>
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: ss.bg, color: ss.text, border: `1px solid ${ss.border}` }}
              >
                {ss.label}
              </span>
            </div>
            <h2 className="text-base font-bold text-[var(--color-text-main)] truncate">{svc.location_name}</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">{svc.client_name}</p>
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
                {format(parseISO(svc.scheduled_start), "HH:mm")} – {format(parseISO(svc.scheduled_end), "HH:mm")}
              </span>
              <span className="text-[var(--color-text-muted)] ml-1.5">
                {format(parseISO(svc.scheduled_start), "EEEE, d 'de' MMMM", { locale: pt })}
              </span>
            </InfoRow>

            <InfoRow icon={MapPin} label="Morada">{svc.location_address}</InfoRow>

            {svc.team_name && (
              <InfoRow icon={Users} label="Equipa">
                <div className="flex items-center gap-1.5">
                  {svc.team_color && (
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.team_color }} />
                  )}
                  {svc.team_name}
                </div>
              </InfoRow>
            )}

            {value != null && (
              <InfoRow icon={Euro} label="Valor">
                <span className="font-semibold">€{value.toFixed(2)}</span>
                {svc.manual_value != null && svc.calculated_value != null && (
                  <span className="text-xs text-[var(--color-text-muted)] ml-1.5">
                    (manual · calculado: €{svc.calculated_value.toFixed(2)})
                  </span>
                )}
              </InfoRow>
            )}

            {svc.notes && (
              <InfoRow icon={FileText} label="Notas">
                <p className="text-sm text-[var(--color-text-sub)] whitespace-pre-line">{svc.notes}</p>
              </InfoRow>
            )}
          </div>

          {/* Tempos reais */}
          {(svc.actual_start || svc.actual_end) && (
            <div className="p-3 rounded-lg bg-[var(--color-primary-light)] border border-[var(--color-primary-muted)]">
              <p className="text-xs font-semibold text-[var(--color-primary)] mb-1.5">Tempo real</p>
              <div className="flex gap-4 text-sm text-[var(--color-primary)]">
                {svc.actual_start && (
                  <span>Entrada: <strong>{format(parseISO(svc.actual_start), "HH:mm")}</strong></span>
                )}
                {svc.actual_end && (
                  <span>Saída: <strong>{format(parseISO(svc.actual_end), "HH:mm")}</strong></span>
                )}
              </div>
            </div>
          )}

          {/* Registos de ponto */}
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
                {timesheets.map((ts) => <TimesheetRow key={ts.id} ts={ts} />)}
              </div>
            )}
          </div>

          {/* Formulário de corrigir clock-out */}
          {fixClockOut && timesheets.length > 0 && (
            <div className="p-4 rounded-lg border border-[var(--color-border)] space-y-3">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Corrigir hora de saída</p>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Colaboradora</label>
                <div className="relative">
                  <select
                    value={clockOutTsId}
                    onChange={(e) => setClockOutTsId(e.target.value)}
                    className={INPUT_CLS + " pr-8 appearance-none"}
                  >
                    <option value="">Selecionar...</option>
                    {timesheets.filter((t) => t.clock_in_at && !t.clock_out_at).map((ts) => (
                      <option key={ts.id} value={ts.id}>
                        {ts.collaborator_id.slice(0, 8)}… (entrou {ts.clock_in_at ? format(parseISO(ts.clock_in_at), "HH:mm") : "?"})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Nova hora de saída</label>
                <input type="time" value={clockOutTime} onChange={(e) => setClockOutTime(e.target.value)} className={INPUT_CLS} />
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

          {/* Painel de cancelamento */}
          {showCancel && (
            <div className="rounded-xl border border-red-200 bg-red-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-red-100">
                <p className="text-sm font-semibold text-red-800 flex items-center gap-1.5">
                  <Ban className="w-4 h-4" /> Cancelar serviço
                </p>
              </div>

              <div className="px-4 py-3 space-y-4">
                {/* Aviso cancelamento tardio */}
                {isLateCancelWarning && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>Cancelamento tardio — menos de 24h de antecedência. Ficará registado.</span>
                  </div>
                )}

                {/* Motivo — pills */}
                <div>
                  <p className="text-xs font-medium text-red-700 mb-2">Motivo *</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(Object.entries(CANCEL_TYPE_LABELS) as [CancelType, string][]).map(([k, v]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setCancelType(k)}
                        className={`px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-colors border ${
                          cancelType === k
                            ? "bg-red-600 text-white border-red-600"
                            : "bg-white text-red-700 border-red-200 hover:bg-red-100"
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Descrição livre */}
                <div>
                  <label className="block text-xs font-medium text-red-700 mb-1">
                    Descrição <span className="font-normal text-red-400">(opcional)</span>
                  </label>
                  <textarea
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-red-200 bg-white text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-transparent resize-none"
                    placeholder="Ex: cliente pediu reagendamento para semana seguinte..."
                  />
                </div>

                {/* Notificar equipa */}
                {svc.team_id && (
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <div
                      onClick={() => setCancelNotifyTeam((v) => !v)}
                      className={`w-9 h-5 rounded-full transition-colors shrink-0 flex items-center ${cancelNotifyTeam ? "bg-red-600" : "bg-gray-300"}`}
                    >
                      <span className={`w-4 h-4 bg-white rounded-full shadow transition-all mx-0.5 ${cancelNotifyTeam ? "translate-x-4" : "translate-x-0"}`} />
                    </div>
                    <span className="text-sm text-red-800">Notificar equipa por push</span>
                  </label>
                )}

                {/* WhatsApp ao cliente */}
                {clientPhone && (
                  <a
                    href={`https://wa.me/${clientPhone.replace(/\D/g, "")}?text=${encodeURIComponent(
                      `Olá ${svc.client_name},\n\nInformamos que o serviço agendado para ${format(parseISO(svc.scheduled_start), "d 'de' MMMM 'às' HH:mm", { locale: pt })} em ${svc.location_name} foi cancelado${cancelType === "client_request" ? " conforme solicitado" : ""}.\n\n${cancelReason ? `Motivo: ${cancelReason}\n\n` : ""}Pedimos desculpa pelo inconveniente. Contacte-nos para reagendar.\n\nMó Limpezas`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border border-green-200 bg-green-50 text-sm font-medium text-green-800 hover:bg-green-100 transition-colors"
                  >
                    <MessageCircle className="w-4 h-4 text-green-600" />
                    Avisar {svc.client_name} por WhatsApp
                  </a>
                )}

                {/* Botões */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleCancel}
                    disabled={actionLoading === "cancelar"}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "cancelar" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                    Confirmar cancelamento
                  </button>
                  <button
                    onClick={() => setShowCancel(false)}
                    className="px-3 py-2 rounded-lg border border-red-200 text-sm text-red-700 hover:bg-red-100 transition-colors"
                  >
                    Voltar
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Painel de contactar cliente */}
          {showNotify && (
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
                <p className="text-sm font-semibold text-[var(--color-text-main)]">
                  Contactar {svc.client_name}
                </p>
                <button
                  onClick={() => setShowNotify(false)}
                  className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-background)]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-[var(--color-border)]">
                {[
                  { key: "whatsapp" as const, icon: MessageCircle, label: "WhatsApp", show: !!clientPhone },
                  { key: "email"    as const, icon: Mail,          label: "Email",    show: !!clientEmail },
                  { key: "team"     as const, icon: Users2,        label: "Equipa",   show: !!svc.team_id },
                ].filter((t) => t.show).map(({ key, icon: Icon, label }) => (
                  <button
                    key={key}
                    onClick={() => setNotifyTab(key)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors -mb-px ${
                      notifyTab === key
                        ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                        : "border-transparent text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              <div className="p-4 space-y-3">
                {/* Tab WhatsApp */}
                {notifyTab === "whatsapp" && clientPhone && (
                  <>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Abre o WhatsApp com a mensagem pré-preenchida. Edita antes de enviar.
                    </p>
                    <textarea
                      value={notifyMsg}
                      onChange={(e) => setNotifyMsg(e.target.value)}
                      rows={4}
                      className={INPUT_CLS + " resize-none text-xs"}
                    />
                    <a
                      href={`https://wa.me/${clientPhone.replace(/\D/g, "")}?text=${encodeURIComponent(notifyMsg)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors"
                    >
                      <MessageCircle className="w-4 h-4" />
                      Abrir WhatsApp
                    </a>
                  </>
                )}

                {/* Tab Email */}
                {notifyTab === "email" && clientEmail && (
                  <>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Será enviado um email para <strong>{clientEmail}</strong>.
                    </p>
                    <textarea
                      value={notifyMsg}
                      onChange={(e) => setNotifyMsg(e.target.value)}
                      rows={4}
                      className={INPUT_CLS + " resize-none text-xs"}
                      placeholder="Mensagem adicional (opcional)..."
                    />
                    <button
                      onClick={handleNotifyEmail}
                      disabled={actionLoading === "notify"}
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
                    >
                      {actionLoading === "notify" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                      Enviar email
                    </button>
                  </>
                )}

                {/* Tab Equipa (push) */}
                {notifyTab === "team" && svc.team_id && (
                  <>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Envia notificação push para todos os membros da equipa <strong>{svc.team_name}</strong>.
                    </p>
                    <textarea
                      value={notifyMsg}
                      onChange={(e) => setNotifyMsg(e.target.value)}
                      rows={3}
                      className={INPUT_CLS + " resize-none text-xs"}
                      placeholder="Mensagem para a equipa..."
                    />
                    <button
                      onClick={handleNotifyTeam}
                      disabled={actionLoading === "notify" || !notifyMsg.trim()}
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
                    >
                      {actionLoading === "notify" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                      Notificar equipa
                    </button>
                  </>
                )}

                {/* Nenhum contacto disponível */}
                {!clientPhone && !clientEmail && !svc.team_id && (
                  <p className="text-sm text-[var(--color-text-muted)] text-center py-2">
                    Sem contactos disponíveis. Adiciona email/telefone na ficha do cliente.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Feedback */}
          {actionMsg && (
            <div className={`text-sm px-3 py-2 rounded-lg border ${
              actionMsg.type === "error"
                ? "bg-red-50 text-red-700 border-red-100"
                : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border-[var(--color-primary-muted)]"
            }`}>
              {actionMsg.text}
            </div>
          )}
        </div>

        {/* Footer — acções */}
        {canAct ? (
          <div className="border-t border-[var(--color-border)] px-6 py-4 space-y-2">
            {/* Notificar estabelecimento */}
            {!showNotify && (
              <button
                onClick={() => setShowNotify(true)}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors"
              >
                <Bell className="w-4 h-4 text-[var(--color-primary)]" />
                Notificar {svc.client_name}
              </button>
            )}
            {timesheets.some((t) => t.clock_in_at && !t.clock_out_at) && !fixClockOut && (
              <button
                onClick={() => setFixClockOut(true)}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors"
              >
                <CheckCircle2 className="w-4 h-4 text-[var(--color-primary)]" />
                Corrigir hora de saída
              </button>
            )}
            {svc.status !== "falta" && (
              <button
                onClick={() => doAction("falta")}
                disabled={actionLoading === "falta"}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-200 text-sm font-medium text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
              >
                {actionLoading === "falta" ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
                Marcar como falta
              </button>
            )}
            {svc.status !== "cancelado" && !showCancel && (
              <button
                onClick={() => setShowCancel(true)}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
              >
                <Ban className="w-4 h-4" />
                Cancelar serviço
              </button>
            )}
          </div>
        ) : (
          <div className="border-t border-[var(--color-border)] px-6 py-4 space-y-2">
            {svc.team_id && !showNotify && (
              <button
                onClick={() => setShowNotify(true)}
                className="w-full flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors"
              >
                <Bell className="w-4 h-4 text-[var(--color-primary)]" />
                Notificar equipa
              </button>
            )}
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <CalendarX className="w-4 h-4" />
              Serviço concluído.
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon, label, children,
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
  const hasWarning = ts.location_warning;
  const initial    = ts.collaborator_id.slice(0, 2).toUpperCase();

  return (
    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-[var(--color-primary)]">{initial}</span>
        </div>
        <span className="text-xs text-[var(--color-text-muted)] font-mono truncate">
          {ts.collaborator_id.slice(0, 8)}…
        </span>
        {hasWarning && (
          <span title="Fora do raio GPS">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs shrink-0 ml-2">
        {ts.clock_in_at ? (
          <span className="text-green-700 font-medium">↑ {format(parseISO(ts.clock_in_at), "HH:mm")}</span>
        ) : (
          <span className="text-[var(--color-text-muted)]">↑ —</span>
        )}
        {ts.clock_out_at ? (
          <span className="text-[var(--color-text-main)] font-medium">↓ {format(parseISO(ts.clock_out_at), "HH:mm")}</span>
        ) : (
          <span className="text-amber-600 font-medium">↓ em falta</span>
        )}
        {ts.duration_minutes != null && (
          <span className="bg-[var(--color-border)] px-1.5 py-0.5 rounded text-[var(--color-text-muted)]">
            {Math.round(ts.duration_minutes / 60 * 10) / 10}h
          </span>
        )}
      </div>
    </div>
  );
}
