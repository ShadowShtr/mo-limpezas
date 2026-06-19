"use client";

import { useState, useEffect, useRef, useCallback, useId } from "react";
import { Bell, CheckCheck, X, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatDistanceToNow } from "@/lib/utils";
import { deleteNotification, deleteAllReadNotifications } from "@/app/actions/notifications";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  new_service:               "Novo serviço",
  service_changed:           "Serviço alterado",
  service_cancelled:         "Serviço cancelado",
  substitute_needed:         "Substituição necessária",
  clock_out_missing:         "Saída em falta",
  vacation_approved:         "Férias aprovadas",
  vacation_rejected:         "Férias recusadas",
  generation_conflict:       "Conflito de geração",
  damage_report_submitted:   "Relatório de avaria",
  absence_requested:         "Pedido de falta",
  vacation_requested:        "Pedido de férias",
};

export function NotificationsBell() {
  const [open, setOpen]                   = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread]               = useState(0);
  const [deletingId, setDeletingId]       = useState<string | null>(null);
  const ref         = useRef<HTMLDivElement>(null);
  const [supabase]  = useState(() => createClient());
  const channelName = `notifications-${useId()}`;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) {
      setNotifications(data);
      setUnread(data.filter((n) => !n.read_at).length);
    }
  }, [supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, load)
      .subscribe();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => { supabase.removeChannel(channel); };
  }, [channelName, load, supabase]);

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  async function markRead(id: string) {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    load();
  }

  async function markAllRead() {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
    load();
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setDeletingId(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setUnread((prev) => {
      const was = notifications.find((n) => n.id === id);
      return was && !was.read_at ? Math.max(0, prev - 1) : prev;
    });
    await deleteNotification(id);
    setDeletingId(null);
  }

  async function handleClearRead() {
    setNotifications((prev) => prev.filter((n) => !n.read_at));
    await deleteAllReadNotifications();
  }

  const hasRead = notifications.some((n) => !!n.read_at);

  return (
    <div ref={ref} className="relative">
      {/* ── Botão sino ── */}
      <button
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        className="relative p-2 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors"
        aria-label="Notificações"
      >
        <Bell className={`w-5 h-5 ${unread > 0 ? "animate-[bellShake_1s_ease-in-out_infinite]" : ""}`} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 rounded-full text-white text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* ── Painel dropdown ── */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[340px] bg-white border border-[var(--color-border)] rounded-2xl shadow-xl z-50 overflow-hidden">

          {/* Cabeçalho */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Notificações</h3>
              {unread > 0 && (
                <span className="min-w-[20px] h-5 px-1.5 bg-red-500 rounded-full text-white text-[10px] font-bold flex items-center justify-center">
                  {unread}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <button
                  onClick={markAllRead}
                  className="flex items-center gap-1 text-[11px] text-[var(--color-primary)] hover:underline px-2 py-1 rounded hover:bg-[var(--color-primary-light)] transition-colors"
                >
                  <CheckCheck className="w-3 h-3" />
                  Marcar lidas
                </button>
              )}
              {hasRead && (
                <button
                  onClick={handleClearRead}
                  className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-red-500 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                  title="Limpar notificações lidas"
                >
                  <Trash2 className="w-3 h-3" />
                  Limpar lidas
                </button>
              )}
            </div>
          </div>

          {/* Lista */}
          <div className="max-h-[380px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Bell className="w-8 h-8 text-[var(--color-text-muted)] mb-2 opacity-40" />
                <p className="text-sm text-[var(--color-text-muted)]">Sem notificações</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`group flex items-start gap-3 px-4 py-3 transition-colors ${
                      !n.read_at ? "bg-[var(--color-primary-light)] hover:bg-green-50" : "hover:bg-[var(--color-background)]"
                    } ${deletingId === n.id ? "opacity-50" : ""}`}
                  >
                    {/* Dot não lida */}
                    <div className="mt-1.5 shrink-0">
                      {!n.read_at
                        ? <span className="block w-2 h-2 rounded-full bg-red-500" />
                        : <span className="block w-2 h-2" />
                      }
                    </div>

                    {/* Conteúdo clicável */}
                    <button
                      className="flex-1 min-w-0 text-left"
                      onClick={() => !n.read_at && markRead(n.id)}
                    >
                      <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-0.5">
                        {TYPE_LABELS[n.type] ?? n.type}
                      </p>
                      <p className="text-sm font-medium text-[var(--color-text-main)] leading-snug">{n.title}</p>
                      {n.body && (
                        <p className="text-xs text-[var(--color-text-sub)] mt-0.5 leading-relaxed">{n.body}</p>
                      )}
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                        {formatDistanceToNow(n.created_at)}
                      </p>
                    </button>

                    {/* X eliminar */}
                    <button
                      onClick={(e) => handleDelete(e, n.id)}
                      className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-all"
                      title="Eliminar"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
