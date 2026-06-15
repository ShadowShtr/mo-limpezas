import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { NotificationsBell } from "./notifications-bell";

interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  backHref?: string;
}

export function Header({ title, subtitle, actions, backHref }: HeaderProps) {
  return (
    <header className="h-16 flex items-center px-4 sm:px-6 lg:px-8 gap-4 sticky top-0 z-30" style={{ background: "var(--glass-bg-strong)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", borderBottom: "1px solid var(--glass-border)" }}>
      {backHref && (
        <Link href={backHref} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors shrink-0">
          <ChevronLeft className="w-5 h-5" />
        </Link>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-bold text-[var(--color-text-main)] truncate">{title}</h1>
        {subtitle && (
          <p className="text-xs text-[var(--color-text-muted)] truncate">{subtitle}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <NotificationsBell />
      </div>
    </header>
  );
}
