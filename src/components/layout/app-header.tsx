"use client";

import Image from "next/image";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface AppHeaderProps {
  userId: string;
  userName: string;
  avatarUrl: string | null;
}

export function AppHeader({ userId, userName, avatarUrl }: AppHeaderProps) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    async function loadUnread() {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("read_at", null);
      setUnread(count ?? 0);
    }

    loadUnread();

    const channel = supabase
      .channel(`app-notifications-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        () => loadUnread()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId]);

  const initials = userName
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-40 px-4 h-14 flex items-center justify-between glass-nav glass-nav-top">
      {/* Logo / Nome */}
      <Link href="/app" className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-[var(--color-primary)] flex items-center justify-center">
          <span className="text-white font-bold text-sm">ML</span>
        </div>
        <span className="font-semibold text-[var(--color-text-main)] text-sm">Mó Limpezas</span>
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
            <Image
              src={avatarUrl}
              alt={userName}
              width={32}
              height={32}
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
