"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface AppHeaderProps {
  userName: string;
  avatarUrl: string | null;
}

export function AppHeader({ userName, avatarUrl }: AppHeaderProps) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    async function loadUnread() {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      setUnread(count ?? 0);
    }

    loadUnread();

    const channel = supabase
      .channel("app-notifications")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        () => loadUnread()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const initials = userName
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-[var(--color-border)] px-4 h-14 flex items-center justify-between">
      {/* Logo / Nome */}
      <Link href="/app" className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-[var(--color-primary)] flex items-center justify-center">
          <span className="text-white font-bold text-sm">E</span>
        </div>
        <span className="font-semibold text-[var(--color-text-main)] text-sm">Escala</span>
      </Link>

      {/* Ações direita */}
      <div className="flex items-center gap-3">
        {/* Sino */}
        <Link href="/app/notificacoes" className="relative p-1.5 rounded-lg hover:bg-[var(--color-primary-light)] transition-colors">
          <Bell className="w-5 h-5 text-[var(--color-text-sub)]" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[var(--color-danger)] rounded-full text-white text-[10px] font-bold flex items-center justify-center">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Link>

        {/* Avatar */}
        <Link href="/app/perfil">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={userName}
              className="w-8 h-8 rounded-full object-cover ring-2 ring-[var(--color-border)]"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center ring-2 ring-[var(--color-border)]">
              <span className="text-[var(--color-primary)] font-semibold text-xs">{initials}</span>
            </div>
          )}
        </Link>
      </div>
    </header>
  );
}
