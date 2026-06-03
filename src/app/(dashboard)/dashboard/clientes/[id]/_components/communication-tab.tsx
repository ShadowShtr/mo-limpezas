"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { Loader2, Bell, BellOff, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ClientData {
  id: string;
  name: string;
  notification_enabled: boolean;
  notification_method: string;
  notification_phone: string | null;
  notification_email: string | null;
}

interface NotifRecord {
  id: string;
  method: string;
  status: string;
  sent_at: string | null;
  message_body: string | null;
  contact_used: string | null;
  created_at: string;
}

interface Props {
  client: ClientData;
  notifications: NotifRecord[];
  userId: string;
}

const METHOD_OPTS = [
  { value: "email", label: "Email" },
  { value: "sms",   label: "SMS" },
  { value: "both",  label: "Ambos (Email + SMS)" },
];

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

// ─── Componente ───────────────────────────────────────────────────────────────

export function CommunicationTab({ client, notifications, userId }: Props) {
  const supabase = createClient();

  const [enabled, setEnabled]   = useState(client.notification_enabled);
  const [method, setMethod]     = useState(client.notification_method ?? "email");
  const [phone, setPhone]       = useState(client.notification_phone ?? "");
  const [email, setEmail]       = useState(client.notification_email ?? "");
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState<{ ok: boolean; text: string } | null>(null);

  const isDirty =
    enabled !== client.notification_enabled ||
    method  !== client.notification_method ||
    phone   !== (client.notification_phone ?? "") ||
    email   !== (client.notification_email ?? "");

  async function handleSave() {
    setSaving(true);
    setMsg(null);

    const { error } = await supabase
      .from("clients")
      .update({
        notification_enabled: enabled,
        notification_method:  method,
        notification_phone:   phone || null,
        notification_email:   email || null,
      })
      .eq("id", client.id);

    setSaving(false);
    if (error) {
      setMsg({ ok: false, text: "Erro ao guardar: " + error.message });
    } else {
      setMsg({ ok: true, text: "Configuração guardada." });
    }
  }

  return (
    <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <h2 className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Comunicação</h2>

      {/* Toggle notificações */}
      <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] mb-4">
        <div className="flex items-center gap-2">
          {enabled
            ? <Bell className="w-4 h-4 text-[var(--color-primary)]" />
            : <BellOff className="w-4 h-4 text-[var(--color-text-muted)]" />}
          <span className="text-sm font-medium text-[var(--color-text-main)]">
            Notificações automáticas
          </span>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? "bg-[var(--color-primary)]" : "bg-gray-300"}`}
        >
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      {enabled && (
        <div className="space-y-3 mb-4">
          {/* Método */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1.5">Método preferido</label>
            <div className="relative">
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={SELECT_CLS}>
                {METHOD_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            </div>
          </div>

          {/* Contactos */}
          {(method === "email" || method === "both") && (
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1.5">Email para notificações</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@exemplo.com" className={INPUT_CLS} />
            </div>
          )}
          {(method === "sms" || method === "both") && (
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1.5">Telemóvel para SMS</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+351 9XX XXX XXX" className={INPUT_CLS} />
            </div>
          )}
        </div>
      )}

      {/* Botão guardar */}
      {isDirty && (
        <div className="flex items-center gap-3 mb-4">
          {msg && <span className={`text-xs font-medium ${msg.ok ? "text-[var(--color-primary)]" : "text-red-600"}`}>{msg.text}</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Guardar configuração
          </button>
        </div>
      )}

      {/* Histórico */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
          Histórico de avisos ({notifications.length})
        </h3>
        {notifications.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">Nenhum aviso enviado ainda.</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {notifications.map((n) => (
              <div key={n.id} className="flex items-start gap-3 px-3 py-2 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] text-xs">
                <div className="flex gap-1.5 shrink-0">
                  <span className={`inline-flex px-1.5 py-0.5 rounded font-semibold ${n.status === "enviado" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                    {n.status === "enviado" ? "Enviado" : "Falhou"}
                  </span>
                  <span className={`inline-flex px-1.5 py-0.5 rounded font-semibold ${n.method === "sms" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                    {n.method === "sms" ? "SMS" : "Email"}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[var(--color-text-sub)] truncate">{n.message_body ?? "—"}</p>
                  <p className="text-[var(--color-text-muted)] mt-0.5">{n.contact_used} · {n.sent_at ? format(parseISO(n.sent_at), "d MMM yyyy, HH:mm", { locale: pt }) : "—"}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
