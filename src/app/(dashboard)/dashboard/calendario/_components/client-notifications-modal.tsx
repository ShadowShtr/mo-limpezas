"use client";

import { useState, useEffect, useMemo } from "react";
import { format, addDays, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { X, Loader2, CheckSquare, Square, Send, Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { sendBulkClientNotifications } from "@/app/actions/email";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Tab = "hoje" | "amanha" | "proximos3";

interface NotifRow {
  serviceId: string;
  clientId: string;
  clientName: string;
  serviceDate: string;       // "YYYY-MM-DD"
  serviceTime: string;       // "HH:MM"
  method: string;            // "sms" | "email" | "both"
  contact: string;           // phone or email
  alreadySent: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  selectedDate: Date;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function ClientNotificationsModal({
  open, onClose, companyId, selectedDate,
}: Props) {
  const supabase = createClient();

  const [tab, setTab]       = useState<Tab>("hoje");
  const [rows, setRows]     = useState<NotifRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Datas por tab
  const tabDates = useMemo<Date[]>(() => {
    if (tab === "hoje")     return [selectedDate];
    if (tab === "amanha")   return [addDays(selectedDate, 1)];
    return [selectedDate, addDays(selectedDate, 1), addDays(selectedDate, 2)];
  }, [tab, selectedDate]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  async function fetchRows() {
    setLoading(true);
    setSelected(new Set());
    setMessage(null);

    const startStr = format(tabDates[0], "yyyy-MM-dd");
    const endStr   = format(tabDates[tabDates.length - 1], "yyyy-MM-dd");

    // Serviços no período, com info de cliente e notificações
    const [{ data: svcs }, { data: sentToday }] = await Promise.all([
      supabase
        .from("services_full")
        .select("id, client_id, client_name, scheduled_start")
        .eq("company_id", companyId)
        .gte("scheduled_start", `${startStr}T00:00:00`)
        .lte("scheduled_start", `${endStr}T23:59:59`)
        .not("status", "in", '("cancelado","falta")')
        .order("scheduled_start"),

      supabase
        .from("client_notifications")
        .select("service_id")
        .eq("company_id", companyId)
        .gte("sent_at", `${startStr}T00:00:00`)
        .lte("sent_at",   `${endStr}T23:59:59`)
        .eq("status", "enviado"),
    ]);

    const sentIds = new Set((sentToday ?? []).map((n) => n.service_id));
    const clientIds = [...new Set((svcs ?? []).map((s) => s.client_id))];

    if (clientIds.length === 0) { setRows([]); setLoading(false); return; }

    // Clientes no período
    const { data: clients } = await supabase
      .from("clients")
      .select("id, name, email, phone")
      .in("id", clientIds);

    const clientMap = new Map((clients ?? []).map((c) => [c.id, c]));

    const built: NotifRow[] = [];
    for (const s of svcs ?? []) {
      const cl = clientMap.get(s.client_id);
      if (!cl) continue;
      const dt = parseISO(s.scheduled_start);
      // Use email by default; add SMS row only if client has a phone number
      const methods: string[] = [];
      if (cl.email) methods.push("email");
      if (cl.phone) methods.push("sms");
      if (methods.length === 0) methods.push("email");
      for (const method of methods) {
        built.push({
          serviceId:   s.id,
          clientId:    cl.id,
          clientName:  s.client_name,
          serviceDate: format(dt, "d MMM", { locale: pt }),
          serviceTime: format(dt, "HH:mm"),
          method,
          contact:     method === "sms" ? (cl.phone ?? "—") : (cl.email ?? "—"),
          alreadySent: sentIds.has(s.id),
        });
      }
    }

    setRows(built);
    setLoading(false);
  }

  useEffect(() => { if (open) fetchRows(); }, [open, tab, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selecção ───────────────────────────────────────────────────────────────

  const pendingRows = rows.filter((r) => !r.alreadySent);

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === pendingRows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingRows.map(rowKey)));
    }
  }

  function rowKey(r: NotifRow) { return `${r.serviceId}_${r.method}`; }

  // ── Enviar ─────────────────────────────────────────────────────────────────

  async function handleSend() {
    const toSend = pendingRows.filter((r) => selected.has(rowKey(r)));
    if (toSend.length === 0) return;

    setSending(true);
    setMessage(null);

    try {
      const result = await sendBulkClientNotifications(
        toSend.map((r) => ({
          serviceId:   r.serviceId,
          clientId:    r.clientId,
          clientName:  r.clientName,
          serviceDate: r.serviceDate,
          serviceTime: r.serviceTime,
          method:      r.method as "sms" | "email",
          contact:     r.contact,
        })),
      );

      if (result.sent > 0 && result.failed === 0) {
        setMessage({ ok: true, text: `${result.sent} email(s) enviado(s) com sucesso.` });
      } else if (result.sent > 0) {
        setMessage({ ok: true, text: `${result.sent} enviado(s), ${result.failed} falharam.` });
      } else {
        const detail = result.errors[0] ?? "Erro desconhecido";
        setMessage({ ok: false, text: `Falha ao enviar: ${detail}` });
      }

      setSelected(new Set());
      fetchRows();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro inesperado ao enviar.";
      setMessage({ ok: false, text: msg });
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "hoje",     label: "Hoje" },
    { key: "amanha",   label: "Amanhã" },
    { key: "proximos3",label: "Próximos 3 dias" },
  ];

  const allPendingSelected = pendingRows.length > 0 && selected.size === pendingRows.length;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] shrink-0">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-[var(--color-primary)]" />
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                Notificar Clientes
              </h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[var(--color-border)] shrink-0 px-6">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  tab === t.key
                    ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "border-transparent text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tabela */}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--color-primary)]" />
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Bell className="w-8 h-8 text-[var(--color-text-muted)]" />
                <p className="text-sm text-[var(--color-text-muted)]">
                  Sem clientes com notificação ativa para este período.
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Ativa notificações na ficha do cliente.
                </p>
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10 bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <tr>
                    <th className="px-4 py-2.5 w-10">
                      <button onClick={toggleAll} className="text-[var(--color-text-muted)] hover:text-[var(--color-primary)]">
                        {allPendingSelected
                          ? <CheckSquare className="w-4 h-4" />
                          : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Estado</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Cliente</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Data</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Método</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Contacto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {rows.map((r) => {
                    const key = rowKey(r);
                    const isChecked = selected.has(key);
                    return (
                      <tr
                        key={key}
                        className={`hover:bg-[var(--color-background)] transition-colors ${r.alreadySent ? "opacity-60" : ""}`}
                        onClick={() => { if (!r.alreadySent) toggleRow(key); }}
                      >
                        <td className="px-4 py-2.5 w-10">
                          {r.alreadySent ? (
                            <span className="text-[var(--color-text-muted)]">—</span>
                          ) : (
                            <span className={isChecked ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}>
                              {isChecked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                            r.alreadySent
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }`}>
                            {r.alreadySent ? "Enviado" : "Pendente"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-medium text-[var(--color-text-main)]">{r.clientName}</td>
                        <td className="px-3 py-2.5 text-[var(--color-text-sub)] whitespace-nowrap">
                          {r.serviceDate} · {r.serviceTime}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                            r.method === "sms"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-purple-100 text-purple-700"
                          }`}>
                            {r.method === "sms" ? "SMS" : "Email"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[var(--color-text-muted)] text-xs font-mono truncate max-w-[150px]">
                          {r.contact}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--color-border)] px-6 py-4 shrink-0">
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              Só são mostrados clientes com notificações ativas. O envio é registado no histórico de cada cliente.
            </p>
            {message && (
              <p className={`text-xs font-medium mb-2 ${message.ok ? "text-[var(--color-primary)]" : "text-red-600"}`}>
                {message.text}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Fechar
              </button>
              <button
                onClick={handleSend}
                disabled={sending || selected.size === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-40"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Enviar ({selected.size})
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
