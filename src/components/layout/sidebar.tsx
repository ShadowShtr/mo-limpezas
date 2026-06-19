"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Calendar,
  FileText,
  Users,
  Building2,
  Map,
  UsersRound,
  BarChart3,
  Settings,
  LogOut,
  X,
  AlertTriangle,
  TrendingUp,
  CheckSquare,
  Clock,
  Bell,
} from "lucide-react";
import { logout } from "@/app/actions/auth";
import { SidebarNotifBadge } from "./sidebar-notif-badge";

// "notif" é um marcador especial para mostrar o SidebarNotifBadge neste item
const NAV: { href: string; icon: typeof Bell; label: string; notif?: boolean }[] = [
  { href: "/dashboard",               icon: LayoutDashboard, label: "Dashboard" },
  { href: "/dashboard/pendencias",    icon: Bell,            label: "Pendências", notif: true },
  { href: "/dashboard/calendario",    icon: Calendar,        label: "Calendário" },
  { href: "/dashboard/clientes",      icon: Building2,       label: "Clientes" },
  { href: "/dashboard/contratos",     icon: FileText,        label: "Contratos" },
  { href: "/dashboard/colaboradores", icon: Users,           label: "Colaboradores" },
  { href: "/dashboard/registo-ponto", icon: Clock,           label: "Registo de Ponto" },
  { href: "/dashboard/equipas",       icon: UsersRound,      label: "Equipas" },
  { href: "/dashboard/faltas",        icon: AlertTriangle,   label: "Faltas" },
  { href: "/dashboard/mapa",          icon: Map,             label: "Mapa" },
  { href: "/dashboard/relatorios",    icon: BarChart3,       label: "Relatórios" },
  { href: "/dashboard/financeiro",    icon: TrendingUp,      label: "Financeiro" },
  { href: "/dashboard/tarefas",       icon: CheckSquare,     label: "Tarefas" },
];

interface SidebarProps {
  userName: string;
  userRole: string;
  avatarUrl?: string | null;
  onClose?: () => void;
}

export function Sidebar({ userName, userRole, avatarUrl, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  function warmRoute(href: string) {
    if (!isActive(href)) router.prefetch(href);
  }

  function handleNavigate(href: string) {
    if (!isActive(href)) setPendingHref(href);
    warmRoute(href);
    onClose?.();
  }

  const initials = userName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <aside
      className="w-[220px] shrink-0 flex flex-col h-screen sticky top-0 glass-dark overflow-hidden"
      style={{ background: "rgba(9,14,26,0.94)" }}
    >
      {/* Background decorative glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div
          className="absolute -top-24 -left-16 w-64 h-64 rounded-full opacity-20"
          style={{
            background: "radial-gradient(circle, rgba(34,197,94,0.35) 0%, transparent 70%)",
            filter: "blur(32px)",
          }}
        />
      </div>

      {/* ── Logo ────────────────────────────────────────── */}
      <div
        className="relative flex items-center gap-3 px-5 h-[60px] shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-lg"
          style={{
            background: "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
            boxShadow: "0 4px 12px rgba(34,197,94,0.35)",
          }}
        >
          <span className="text-white font-bold text-xs tracking-wide">ML</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm leading-none truncate">Mó Limpezas</p>
          <p className="text-[10px] mt-0.5" style={{ color: "rgba(148,163,184,0.55)" }}>
            Gestão de limpeza
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "rgba(148,163,184,0.6)" }}
            aria-label="Fechar menu"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ── Navegação ────────────────────────────────────── */}
      <nav className="relative flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map(({ href, icon: Icon, label, notif }) => {
          const active = isActive(href);
          const pending = pendingHref === href && !active;
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              onClick={() => handleNavigate(href)}
              onFocus={() => warmRoute(href)}
              onTouchStart={() => warmRoute(href)}
              className="relative flex items-center gap-3 px-3 py-[9px] rounded-xl text-[13px] font-medium transition-all duration-150 group"
              style={
                active || pending
                  ? {
                      background: "rgba(34,197,94,0.13)",
                      color: "#22C55E",
                    }
                  : {
                      color: "rgba(226,232,240,0.65)",
                    }
              }
              onMouseEnter={(e) => {
                warmRoute(href);
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.055)";
                  (e.currentTarget as HTMLElement).style.color = "rgba(248,250,252,0.95)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background = "";
                  (e.currentTarget as HTMLElement).style.color = "rgba(226,232,240,0.65)";
                }
              }}
            >
              {/* Active indicator */}
              {(active || pending) && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full"
                  style={{ background: "#22C55E", boxShadow: "0 0 8px rgba(34,197,94,0.6)" }}
                />
              )}

              <Icon
                className="w-[17px] h-[17px] shrink-0"
                style={{ color: active || pending ? "#22C55E" : undefined }}
              />
              <span className="flex-1 truncate">{label}</span>
              {pending && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] animate-pulse" aria-hidden />
              )}
              {notif && !pending && <SidebarNotifBadge />}
            </Link>
          );
        })}
      </nav>

      {/* ── Divisor ──────────────────────────────────────── */}
      <div className="relative px-3 pb-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="h-2" />
        <Link
          href="/dashboard/configuracoes"
          prefetch={true}
          onClick={() => handleNavigate("/dashboard/configuracoes")}
          onFocus={() => warmRoute("/dashboard/configuracoes")}
          onTouchStart={() => warmRoute("/dashboard/configuracoes")}
          className="flex items-center gap-3 px-3 py-[9px] rounded-xl text-[13px] font-medium transition-all duration-150"
          style={
            pathname.startsWith("/dashboard/configuracoes") ||
            (pendingHref === "/dashboard/configuracoes" && !pathname.startsWith("/dashboard/configuracoes"))
              ? { background: "rgba(34,197,94,0.13)", color: "#22C55E" }
              : { color: "rgba(226,232,240,0.55)" }
          }
          onMouseEnter={(e) => {
            warmRoute("/dashboard/configuracoes");
            if (!pathname.startsWith("/dashboard/configuracoes")) {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.055)";
              (e.currentTarget as HTMLElement).style.color = "rgba(248,250,252,0.90)";
            }
          }}
          onMouseLeave={(e) => {
            if (!pathname.startsWith("/dashboard/configuracoes")) {
              (e.currentTarget as HTMLElement).style.background = "";
              (e.currentTarget as HTMLElement).style.color = "rgba(226,232,240,0.55)";
            }
          }}
        >
          <Settings className="w-[17px] h-[17px] shrink-0" />
          Configurações
          {pendingHref === "/dashboard/configuracoes" && !pathname.startsWith("/dashboard/configuracoes") && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#22C55E] animate-pulse" aria-hidden />
          )}
        </Link>
      </div>

      {/* ── Utilizador ──────────────────────────────────── */}
      <div
        className="relative shrink-0 p-3 mx-3 mb-3 rounded-2xl"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center font-semibold text-xs"
            style={{
              background: avatarUrl ? "transparent" : "rgba(34,197,94,0.2)",
              border: "1.5px solid rgba(34,197,94,0.3)",
              color: "#22C55E",
            }}
          >
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt={userName} className="w-full h-full object-cover" />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p
              className="text-[12px] font-semibold truncate leading-none mb-0.5"
              style={{ color: "rgba(248,250,252,0.90)" }}
            >
              {userName}
            </p>
            <p className="text-[10px] capitalize" style={{ color: "rgba(148,163,184,0.55)" }}>
              {userRole}
            </p>
          </div>
          <form action={logout}>
            <button
              type="submit"
              title="Sair"
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: "rgba(148,163,184,0.45)" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#EF4444")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "rgba(148,163,184,0.45)")}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
