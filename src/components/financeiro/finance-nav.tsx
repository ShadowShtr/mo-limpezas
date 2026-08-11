"use client";

// ============================================================================
// Navegação do módulo Financeiro — Financeiro V2, PR A
// ============================================================================
//
// **Um único sistema de navegação financeira.** A barra lateral colapsou para um
// item "Financeiro"; a navegação fina vive aqui, dentro do módulo.
//
// Antes havia dois caminhos para os mesmos sete destinos — sete entradas na
// barra lateral **e** seis cartões de atalho no Resumo — que podiam discordar
// entre si sobre o que estava activo.
//
// 🔴 Navegar é **read-only**. Estes são `<Link>`; nenhum dispara acção.
// ============================================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  TrendingUp, Repeat, FileText, BarChart2, Receipt, Wallet, Landmark,
} from "lucide-react";

import {
  type FinancePeriod,
  withFinancePeriod,
} from "@/lib/finance-period";

/**
 * As sete vistas, com as rotas que **já existem**.
 *
 * Nenhuma rota foi criada nem movida para debaixo de `/financeiro` só por
 * simetria de URL: Cobranças e Folha de Pagamento continuam onde estavam, e
 * mover ambas partiria ligações e favoritos por uma questão estética.
 */
export const FINANCE_VIEWS = [
  { href: "/dashboard/financeiro",             label: "Resumo",             icon: TrendingUp },
  { href: "/dashboard/financeiro/pagamentos",  label: "Pagamentos",         icon: Repeat },
  { href: "/dashboard/financeiro/contas",      label: "Contas",             icon: FileText },
  { href: "/dashboard/financeiro/fluxo-caixa", label: "Fluxo de Caixa",     icon: BarChart2 },
  { href: "/dashboard/cobrancas",              label: "Cobranças",          icon: Receipt },
  { href: "/dashboard/folha-pagamento",        label: "Folha de Pagamento", icon: Wallet },
  { href: "/dashboard/financeiro/conciliacao", label: "Conciliação",        icon: Landmark },
] as const;

/**
 * Vistas que não participam no período global.
 *
 * ✅ **Nenhuma.** As sete partilham o mesmo mês.
 *
 * Pagamentos esteve aqui, e por uma razão concreta: `getPayments` chamava
 * `ensureMonth`, que inseria. Um período global teria tornado esse gatilho
 * trivial de puxar — passar de Agosto para Setembro em qualquer vista e clicar
 * em Pagamentos materializaria Setembro, e as setas ‹ › fariam o mesmo a cada
 * clique. O isolamento era a contenção possível **enquanto ler escrevia**.
 *
 * A PR C tirou a escrita do caminho de leitura. A condição que justificava o
 * isolamento deixou de existir, e mantê-lo passaria a ser só uma cicatriz: uma
 * vista fora do período do módulo, sem nada que o explique ao utilizador.
 *
 * Se alguma vista voltar a precisar de isolamento, esta lista é o sítio — e a
 * razão tem de vir escrita ao lado.
 */
export const PERIOD_ISOLATED_VIEWS: readonly string[] = [];

export function isPeriodIsolated(pathname: string): boolean {
  return PERIOD_ISOLATED_VIEWS.some((h) => pathname === h || pathname.startsWith(`${h}/`));
}

/**
 * Qual das vistas corresponde a um caminho.
 *
 * Escolhe a correspondência **mais longa**: `/dashboard/financeiro` é prefixo de
 * todas as suas filhas, e um simples `startsWith` marcaria "Resumo" como activo
 * em todas elas.
 */
export function activeFinanceView(pathname: string): string | null {
  let melhor: string | null = null;
  for (const v of FINANCE_VIEWS) {
    if (pathname === v.href || pathname.startsWith(`${v.href}/`)) {
      if (melhor === null || v.href.length > melhor.length) melhor = v.href;
    }
  }
  return melhor;
}

export function FinanceNav({ period }: { period: FinancePeriod }) {
  const pathname = usePathname();
  const activa = activeFinanceView(pathname);

  return (
    <nav
      aria-label="Secções do Financeiro"
      // Scroll horizontal discreto quando não cabe — em vez de um segundo menu
      // no telemóvel, que voltaria a criar duas navegações.
      className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:thin]"
    >
      {FINANCE_VIEWS.map(({ href, label, icon: Icon }) => {
        const active = activa === href;
        // Uma vista isolada recebe a rota **limpa**: o período não a atravessa.
        // Ver PERIOD_ISOLATED_VIEWS — em Pagamentos, transportar o mês faria
        // com que clicar no separador gerasse esse mês.
        const destino = isPeriodIsolated(href) ? href : withFinancePeriod(href, period);
        return (
          <Link
            key={href}
            href={destino}
            prefetch
            aria-current={active ? "page" : undefined}
            className={[
              "shrink-0 inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-semibold",
              "transition-colors whitespace-nowrap",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A] focus-visible:ring-offset-2",
              active
                ? "bg-[#16A34A] text-white shadow-sm"
                : "text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A]",
            ].join(" ")}
          >
            <Icon className="w-4 h-4 shrink-0" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
