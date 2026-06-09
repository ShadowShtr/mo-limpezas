"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bell, CalendarPlus, CalendarClock, CalendarX, UserPlus,
  AlertTriangle, CheckCircle2, XCircle, CheckCheck,
} from "lucide-react";
import {
  markNotificationRead,
  markAllNotificationsRead,
  type AppNotification,
} from "@/app/actions/notifications";

const ICON: Record<string, { Icon: typeof Bell; cls: string }> = {
  new_service:         { Icon: CalendarPlus,  cls: "text-[var(--color-primary)] bg-[var(--color-primary-light)]" },
  service_changed:     { Icon: CalendarClock, cls: "text-amber-600 bg-amber-50" },
  service_cancelled:   { Icon: CalendarX,     cls: "text-red-600 bg-red-50" },
  substitute_needed:   { Icon: UserPlus,      cls: "text-blue-600 bg-blue-50" },
  clock_out_missing:   { Icon: AlertTriangle, cls: "text-amber-600 bg-amber-50" },
  vacation_approved:   { Icon: CheckCircle2,  cls: "text-green-600 bg-green-50" },
  vacation_rejected:   { Icon: XCircle,       cls: "text-red-600 bg-red-50" },
  generation_conflict: { Icon: AlertTriangle, cls: "text-amber-600 bg-amber-50" },
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `há ${d} dia${d !== 1 ? "s" : ""}`;
  return new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
}

export function NotificationsList({ initial }: { initial: AppNotification[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [, startTransition] = useTransition();

  const hasUnread = items.some((n) => !n.read_at);

  function handleClick(n: AppNotification) {
    if (!n.read_at) {
      setItems((prev) => prev.map((x) => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
      startTransition(() => { markNotificationRead(n.id); });
    }
    const serviceId = n.data?.service_id as string | undefined;
    if (serviceId) router.push(`/app/servico/${serviceId}`);
  }

  function handleMarkAll() {
    setItems((prev) => prev.map((x) => x.read_at ? x : { ...x, read_at: new Date().toISOString() }));
    startTransition(() => { markAllNotificationsRead(); });
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-[var(--color-border)] p-8 text-center">
        <div className="w-12 h-12 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-3">
          <Bell className="w-6 h-6 text-[var(--color-primary)]" />
        </div>
        <p className="text-sm font-medium text-[var(--color-text-main)]">Sem notificações</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">As tuas notificações aparecem aqui.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasUnread && (
        <button
          onClick={handleMarkAll}
          className="self-end flex items-center gap-1.5 text-xs font-medium text-[var(--color-primary)] active:opacity-70"
        >
          <CheckCheck className="w-3.5 h-3.5" />
          Marcar todas como lidas
        </button>
      )}

      <div className="flex flex-col gap-2">
        {items.map((n) => {
          const conf = ICON[n.type] ?? { Icon: Bell, cls: "text-[var(--color-text-muted)] bg-[var(--color-background)]" };
          const { Icon } = conf;
          const unread = !n.read_at;
          return (
            <button
              key={n.id}
              onClick={() => handleClick(n)}
              className={`w-full text-left bg-white rounded-2xl border p-4 flex gap-3 items-start active:scale-[0.99] transition-transform ${
                unread ? "border-[var(--color-primary-muted)]" : "border-[var(--color-border)]"
              }`}
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${conf.cls}`}>
                <Icon className="w-4.5 h-4.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--color-text-main)]">{n.title}</p>
                  {unread && <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] shrink-0 mt-1.5" />}
                </div>
                {n.body && (
                  <p className="text-xs text-[var(--color-text-sub)] mt-0.5 leading-relaxed">{n.body}</p>
                )}
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{relativeTime(n.created_at)}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
