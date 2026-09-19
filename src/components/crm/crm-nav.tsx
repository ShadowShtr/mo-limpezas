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
//
// ---------------------------------------------------------------------------
// 🔴 Porque é que só há uma vista aqui
// ---------------------------------------------------------------------------
//
// Visitas e Orçamentos existem como ecrãs, mas as tabelas que eles leem —
// `crm_visits` (102) e `crm_quotes` (103) — ainda NÃO existem em produção.
// Uma entrada nesta barra para qualquer uma delas levaria a uma página que
// rebenta na primeira consulta.
//
// A regra é simples e não é temporária: **uma vista só entra nesta lista
// quando a migration de que depende estiver aplicada em produção.** Cada
// linha nova aqui viaja na mesma PR que a sua migration, nunca antes.
//
// Há um ensaio que trava a regressão: nenhuma vista pode apontar para uma
// rota sem página no repositório.
// ============================================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KanbanSquare } from "lucide-react";

/**
 * As vistas do módulo, por ordem de trabalho.
 *
 * Nenhuma entrada aqui aponta para uma rota que não exista — um destino que
 * dá 404, ou que rebenta por falta de tabela, é pior do que um destino que
 * ainda não se mostra.
 */
export const CRM_VIEWS = [
  { href: "/dashboard/crm", label: "Pipeline de Leads", icon: KanbanSquare },
] as const;

/**
 * Qual das vistas está activa.
 *
 * Correspondência mais longa primeiro: com rotas aninhadas, `/dashboard/crm`
 * casaria com tudo o que vem abaixo e duas abas ficariam acesas ao mesmo
 * tempo. Continua assim com uma vista só, para o dia em que forem três.
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

  // Uma barra de separadores com um separador só não é navegação — é uma
  // etiqueta a ocupar uma linha. Volta a aparecer sozinha quando a segunda
  // vista chegar com a sua migration.
  if (CRM_VIEWS.length < 2) return null;

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
