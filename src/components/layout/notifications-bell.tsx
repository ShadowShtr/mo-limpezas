"use client";

import { useState, useEffect, useRef } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatDistanceToNow } from "@/lib/utils";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  new_service: "Novo serviço",
  service_changed: "Serviço alterado",
  service_cancelled: "Serviço cancelado",
  substitute_needed: "Substituição necessária",
  clock_out_missing: "Saída em falta",
  vacation_approved: "Férias aprovadas",
  vacation_rejected: "Férias recusadas",
  generation_conflict: "Conflito de geração",
};

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  useEffect(() => {
    loadNotifications();

    const channel = supabase
      .channel("notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, () => {
        loadNotifications();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function loadNotifications() {
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(20);

    if (data) {
      setNotifications(data);
      setUnread(data.filter((n) => !n.read_at).length);
    }
  }

  async function markAllRead() {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    loadNotifications();
  }

  async function markRead(id: string) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id);
    loadNotifications();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors"
      >
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[var(--color-danger)] rounded-full" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-[var(--color-border)] rounded-xl shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">
              Notificações {unread > 0 && <span className="text-[var(--color-danger)]">({unread})</span>}
            </h3>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Marcar tudo como lido
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-[var(--color-border)]">
            {notifications.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] text-center py-6">
                Sem notificações
              </p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => !n.read_at && markRead(n.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-[var(--color-background)] transition-colors ${
                    !n.read_at ? "bg-[var(--color-primary-light)]" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read_at && (
                      <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] mt-1.5 shrink-0" />
                    )}
                    <div className={!n.read_at ? "" : "pl-3.5"}>
                      <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
                        {TYPE_LABELS[n.type] ?? n.type}
                      </p>
                      <p className="text-sm font-medium text-[var(--color-text-main)]">{n.title}</p>
                      {n.body && (
                        <p className="text-xs text-[var(--color-text-sub)] mt-0.5">{n.body}</p>
                      )}
                      <p className="text-xs text-[var(--color-text-muted)] mt-1">
                        {formatDistanceToNow(n.created_at)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
