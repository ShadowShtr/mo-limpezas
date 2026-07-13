"use client";

import { useState, useEffect, useMemo } from "react";
import { format, addDays, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { X, Loader2, CheckSquare, Square, Send, Bell, MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { sendBulkClientNotifications, getCompanyPhone } from "@/app/actions/email";
import { clientReminderWhatsAppMessage } from "@/lib/email/templates";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Tab = "hoje" | "amanha" | "proximos3";
type Method = "email" | "whatsapp" | "none";

interface ServiceItem {
  serviceId: string;
  date: string;       // "8 jul"
  time: string;        // "HH:MM"
  address: string;
  value: number | null;
  alreadySent: boolean; // só relevante para email
}

interface ClientRow {
  clientId: string;
  clientName: string;
  method: Method;
  contact: string;     // email ou telefone
  services: ServiceItem[];
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
  const [rows, setRows]     = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [companyPhone, setCompanyPhone] = useState("925 780 509");

  useEffect(() => { getCompanyPhone().then(setCompanyPhone); }, []);

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

    // Serviços no período, já com email/telefone/valor do cliente (services_full
    // traz tudo — não precisa de query separada a "clients").
    const [{ data: svcs }, { data: sentToday }] = await Promise.all([
      supabase
        .from("services_full")
        .select("id, client_id, client_name, scheduled_start, location_address, client_email, client_phone, manual_value, calculated_value")
        .eq("company_id", companyId)
        .gte("scheduled_start", toLisbonTimestamp(startStr, "00:00"))
        .lt("scheduled_start", toLisbonTimestamp(addDaysToDateString(endStr, 1), "00:00"))
        .not("status", "in", '("cancelado","falta")')
        .order("scheduled_start"),

      supabase
        .from("client_notifications")
        .select("service_id")
        .eq("company_id", companyId)
        .eq("method", "email")
        .gte("sent_at", toLisbonTimestamp(startStr, "00:00"))
        .lt("sent_at", toLisbonTimestamp(addDaysToDateString(endStr, 1), "00:00"))
        .eq("status", "enviado"),
    ]);

    const sentIds = new Set((sentToday ?? []).map((n) => n.service_id));

    // Agrupa por cliente: cada cliente fica com UMA linha por canal disponível
    // (email e/ou WhatsApp), listando TODOS os serviços do período nessa linha
    // — em vez de um aviso fragmentado por serviço.
    const byClient = new Map<string, { name: string; email: string | null; phone: string | null; items: ServiceItem[] }>();
    for (const s of svcs ?? []) {
      const dt = parseISO(s.scheduled_start);
      const item: ServiceItem = {
        serviceId: s.id,
        date: format(dt, "d MMM", { locale: pt }),
        time: format(dt, "HH:mm"),
        address: s.location_address,
        value: s.manual_value ?? s.calculated_value ?? null,
        alreadySent: sentIds.has(s.id),
      };
      const existing = byClient.get(s.client_id);
      if (existing) {
        existing.items.push(item);
      } else {
        byClient.set(s.client_id, { name: s.client_name, email: s.client_email, phone: s.client_phone, items: [item] });
      }
    }

    const built: ClientRow[] = [];
    for (const [clientId, c] of byClient) {
      const methods: Method[] = [];
      if (c.email) methods.push("email");
      if (c.phone) methods.push("whatsapp");
      if (methods.length === 0) methods.push("none");
      for (const method of methods) {
        built.push({
          clientId,
          clientName: c.name,
          method,
          contact: method === "whatsapp" ? (c.phone ?? "—") : method === "email" ? (c.email ?? "—") : "Sem email/telefone",
          services: c.items,
        });
      }
    }
    built.sort((a, b) => a.clientName.localeCompare(b.clientName));

    setRows(built);
    setLoading(false);
  }

  useEffect(() => { if (open) fetchRows(); }, [open, tab, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

  // ── Selecção (só linhas de email — WhatsApp é sempre ação manual imediata) ──

  function rowFullySent(r: ClientRow) {
    return r.method === "email" && r.services.every((s) => s.alreadySent);
  }

  const pendingRows = rows.filter((r) => r.method === "email" && !rowFullySent(r));

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  function rowKey(r: ClientRow) { return `${r.clientId}_${r.method}`; }

  function whatsappUrl(r: ClientRow) {
    const msg = clientReminderWhatsAppMessage({
      clientName: r.clientName,
      services: r.services.map((s) => ({ date: s.date, time: s.time, address: s.address, value: s.value })),
      companyPhone,
    });
    return `https://wa.me/${r.contact.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;
  }

  // ── Enviar (email) ────────────────────────────────────────────────────────

  async function handleSend() {
    const toSend = pendingRows.filter((r) => selected.has(rowKey(r)));
    if (toSend.length === 0) return;

    setSending(true);
    setMessage(null);

    try {
      const result = await sendBulkClientNotifications(
        toSend.map((r) => ({
          clientId:   r.clientId,
          clientName: r.clientName,
          contact:    r.contact,
          services: r.services.map((s) => ({
            serviceId: s.serviceId, date: s.date, time: s.time, address: s.address, value: s.value,
          })),
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
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">

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
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Datas</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Método</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--color-text-muted)]">Contacto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {rows.map((r) => {
                    const key = rowKey(r);
                    const isChecked = selected.has(key);
                    const fullySent = rowFullySent(r);
                    const datesLabel = r.services.map((s) => `${s.date} · ${s.time}`).join(", ");
                    return (
                      <tr
                        key={key}
                        className={`hover:bg-[var(--color-background)] transition-colors ${fullySent || r.method === "none" ? "opacity-60" : ""}`}
                        onClick={() => { if (r.method === "email" && !fullySent) toggleRow(key); }}
                      >
                        <td className="px-4 py-2.5 w-10" onClick={(e) => r.method === "whatsapp" && e.stopPropagation()}>
                          {r.method === "whatsapp" ? (
                            <a
                              href={whatsappUrl(r)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Abrir WhatsApp"
                              className="inline-flex text-green-600 hover:text-green-700"
                            >
                              <MessageCircle className="w-4 h-4" />
                            </a>
                          ) : fullySent || r.method === "none" ? (
                            <span className="text-[var(--color-text-muted)]">—</span>
                          ) : (
                            <span className={isChecked ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}>
                              {isChecked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                            fullySent
                              ? "bg-green-100 text-green-700"
                              : r.method === "none"
                              ? "bg-gray-100 text-gray-500"
                              : r.method === "whatsapp"
                              ? "bg-green-50 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }`}>
                            {fullySent ? "Enviado" : r.method === "none" ? "Sem contacto" : r.method === "whatsapp" ? "Manual" : "Pendente"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-medium text-[var(--color-text-main)]">{r.clientName}</td>
                        <td className="px-3 py-2.5 text-[var(--color-text-sub)] whitespace-nowrap max-w-[220px] truncate" title={datesLabel}>
                          {datesLabel}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                            r.method === "whatsapp"
                              ? "bg-blue-100 text-blue-700"
                              : r.method === "email"
                              ? "bg-purple-100 text-purple-700"
                              : "bg-gray-100 text-gray-500"
                          }`}>
                            {r.method === "whatsapp" ? "WhatsApp" : r.method === "email" ? "Email" : "—"}
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
              Só são mostrados clientes com notificações ativas. Email é enviado em lote por aqui;
              WhatsApp abre uma mensagem pronta (ícone verde) para enviares manualmente.
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
