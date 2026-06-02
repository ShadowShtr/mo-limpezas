import { NotificationsBell } from "./notifications-bell";

interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="h-16 bg-white border-b border-[var(--color-border)] flex items-center px-6 gap-4 sticky top-0 z-30">
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
