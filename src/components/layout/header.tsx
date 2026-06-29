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
    <header
      className="h-[60px] flex items-center px-6 gap-4 sticky top-0 z-40"
      style={{
        background: "rgba(240,244,248,0.82)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(15,23,42,0.07)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.65), 0 2px 8px rgba(15,23,42,0.04)",
      }}
    >
      {backHref && (
        <Link
          href={backHref}
          className="p-1.5 rounded-xl transition-colors shrink-0"
          style={{ color: "var(--color-text-muted)" }}
        >
          <ChevronLeft className="w-5 h-5" />
        </Link>
      )}
      <div className="flex-1 min-w-0">
        <h1
          className="text-[15px] font-bold truncate leading-none"
          style={{ color: "var(--color-text-main)", letterSpacing: "-0.01em" }}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--color-text-muted)" }}>
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <NotificationsBell />
      </div>
    </header>
  );
}
