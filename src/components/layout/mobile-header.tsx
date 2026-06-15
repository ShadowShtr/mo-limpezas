"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { NotificationsBell } from "./notifications-bell";

interface Props {
  userName: string;
  avatarUrl?: string | null;
  onMenuClick: () => void;
}

export function MobileHeader({ userName, avatarUrl, onMenuClick }: Props) {
  const initials = userName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <header className="lg:hidden h-14 flex items-center px-4 gap-3 sticky top-0 z-30 glass-nav glass-nav-top">
      <button
        onClick={onMenuClick}
        className="p-2 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
        aria-label="Abrir menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      <Link href="/dashboard" className="flex items-center gap-2 flex-1">
        <div className="w-7 h-7 rounded-lg bg-[var(--color-primary)] flex items-center justify-center">
          <span className="text-white font-bold text-sm">ML</span>
        </div>
        <span className="font-bold text-[var(--color-text-main)] text-[15px]">Mó Limpezas</span>
      </Link>

      <div className="flex items-center gap-2">
        <NotificationsBell />
        <div className="w-8 h-8 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0 overflow-hidden">
          {avatarUrl ? (
            <img src={avatarUrl} alt={userName} className="w-full h-full object-cover" />
          ) : (
            <span className="text-[var(--color-primary)] font-semibold text-xs">{initials}</span>
          )}
        </div>
      </div>
    </header>
  );
}
