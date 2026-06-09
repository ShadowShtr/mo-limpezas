"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, CalendarDays, ClipboardList, User } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/app",           label: "Hoje",      icon: Home },
  { href: "/app/escala",    label: "Horário",   icon: CalendarDays },
  { href: "/app/ausencias", label: "Ausências", icon: ClipboardList },
  { href: "/app/perfil",    label: "Eu",        icon: User },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-[var(--color-border)] safe-area-pb">
      <div className="flex">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-colors",
                isActive
                  ? "text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)]"
              )}
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 rounded-full bg-[var(--color-primary)]" />
              )}
              <Icon className={cn("w-5 h-5", isActive && "stroke-[2.5]")} />
              <span className={cn("text-[10px] font-medium", isActive && "font-semibold")}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
