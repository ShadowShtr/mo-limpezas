"use client";

// ============================================================================
// Navegação do módulo CRM
// ============================================================================
//
// Mesma decisão do Financeiro V2: **um** item na barra lateral, e a navegação
// fina aqui dentro. A barra lateral ficou plana de propósito — ter lá três
// entradas comerciais faria crescer outra vez a lista que já foi encolhida uma
// vez, e voltaria a haver dois sítios a discordar sobre o que está activo.
//
// 🔴 Navegar é read-only. Estes são `<Link>`; nenhum dispara acção.
// ============================================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KanbanSquare, CalendarClock, FileText } from "lucide-react";

/**
 * As vistas do módulo.
 *
 * As três, por ordem de trabalho: primeiro o funil, depois a visita, depois o
 * orçamento. Nenhuma entrada aqui aponta para uma rota que não exista — um
 * destino que dá 404 é pior do que um destino que não se mostra.
 */
export const CRM_VIEWS = [
  { href: "/dashboard/crm", label: "Pipeline de Leads", icon: KanbanSquare },
  { href: "/dashboard/crm/visitas", label: "Visitas", icon: CalendarClock },
  { href: "/dashboard/crm/orcamentos", label: "Orçamentos", icon: FileText },
] as const;

/**
 * Qual das vistas está activa.
 *
 * Correspondência mais longa primeiro: com rotas aninhadas, `/dashboard/crm`
 * casaria com tudo o que vem abaixo e duas abas ficariam acesas ao mesmo
 * tempo.
 */
export function activeCrmView(pathname: string): string | null {
  const candidatas = [...CRM_VIEWS]
    .map((v) => v.href)
    .sort((a, b) => b.length - a.length);
  return candidatas.find((href) => pathname === href || pathname.startsWith(`${href}/`)) ?? null;
}

export function CrmNav() {
  const pathname = usePathname();
  const activo = activeCrmView(pathname);

  return (
    <nav
      aria-label="Secções do CRM"
      className="flex items-center gap-1 overflow-x-auto border-b pb-px"
      style={{ borderColor: "var(--color-border)" }}
    >
      {CRM_VIEWS.map(({ href, label, icon: Icon }) => {
        const isActive = activo === href;
        return (
          <Link
            key={href}
            href={href}
            prefetch
            aria-current={isActive ? "page" : undefined}
            className="flex shrink-0 items-center gap-2 rounded-t-lg px-3 py-2 text-[13px] font-medium transition-colors"
            style={
              isActive
                ? { color: "#16A34A", borderBottom: "2px solid #16A34A" }
                : { color: "var(--color-text-muted)", borderBottom: "2px solid transparent" }
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        );
      })}

    </nav>
  );
}
