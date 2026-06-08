"use client";

import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";

interface ClientData {
  id: string;
  name: string;
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
}

export function CommunicationTab({ notifications }: Props) {
  return (
    <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <h2 className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Comunicação</h2>

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
