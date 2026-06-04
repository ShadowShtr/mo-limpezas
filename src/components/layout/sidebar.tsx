"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Calendar,
  FileText,
  Users,
  Building2,
  MapPin,
  Map,
  UsersRound,
  BarChart3,
  Settings,
  LogOut,
  X,
  AlertTriangle,
  Car,
} from "lucide-react";
import { logout } from "@/app/actions/auth";

const NAV = [
  { href: "/dashboard",               icon: LayoutDashboard, label: "Dashboard" },
  { href: "/dashboard/calendario",    icon: Calendar,        label: "Calendário" },
  { href: "/dashboard/contratos",     icon: FileText,        label: "Contratos" },
  { href: "/dashboard/colaboradores", icon: Users,           label: "Colaboradores" },
  { href: "/dashboard/faltas",        icon: AlertTriangle,   label: "Faltas" },
  { href: "/dashboard/mapa",          icon: Map,             label: "Mapa" },
  { href: "/dashboard/clientes",      icon: Building2,       label: "Clientes" },
  { href: "/dashboard/locais",        icon: MapPin,          label: "Locais" },
  { href: "/dashboard/equipas",       icon: UsersRound,      label: "Equipas" },
  { href: "/dashboard/relatorios",    icon: BarChart3,       label: "Relatórios" },
  { href: "/dashboard/viaturas",      icon: Car,             label: "Viaturas" },
];

interface SidebarProps {
  userName: string;
  userRole: string;
  avatarUrl?: string | null;
  onClose?: () => void;
}

export function Sidebar({ userName, userRole, avatarUrl, onClose }: SidebarProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  const initials = userName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <aside className="w-60 shrink-0 flex flex-col h-screen bg-white border-r border-[var(--color-border)] sticky top-0">

      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-16 border-b border-[var(--color-border)]">
        <div className="w-8 h-8 rounded-lg bg-[var(--color-primary)] flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">E</span>
        </div>
        <span className="font-bold text-[var(--color-text-main)] text-[15px] flex-1">Escala</span>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Fechar menu"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Navegação */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV.map(({ href, icon: Icon, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-[var(--color-primary-light)] text-[var(--color-primary)] border-l-[3px] border-[var(--color-primary)] pl-[9px]"
                  : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)]"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Divisor */}
      <div className="px-3 pb-1">
        <Link
          href="/dashboard/configuracoes"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            pathname.startsWith("/dashboard/configuracoes")
              ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
              : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)]"
          }`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          Configurações
        </Link>
      </div>

      {/* Utilizador */}
      <div className="border-t border-[var(--color-border)] p-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0 overflow-hidden">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt={userName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-[var(--color-primary)] font-semibold text-xs">{initials}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-text-main)] truncate">{userName}</p>
            <p className="text-xs text-[var(--color-text-muted)] capitalize">{userRole}</p>
          </div>
          <form action={logout}>
            <button
              type="submit"
              title="Sair"
              className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
