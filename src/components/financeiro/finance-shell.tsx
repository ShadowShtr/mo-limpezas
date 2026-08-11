// ============================================================================
// Casca do módulo Financeiro — Financeiro V2, PR A
// ============================================================================
//
// Ordem fixa, igual nas sete vistas:
//
//     AVISOS  →  cabeçalho + período + sino  →  navegação  →  conteúdo
//
// Os avisos ficam **primeiro** e fora da navegação: são informação de atenção
// imediata e não podem ficar escondidos atrás de uma aba.
//
// 🔴 Componente de servidor sem efeitos. Renderizar a casca não lê nem escreve
//    nada — recebe o período já resolvido e desenha.
// ============================================================================

import type { ReactNode } from "react";

import { Header } from "@/components/layout/header";
import { type FinancePeriod, formatFinancePeriod } from "@/lib/finance-period";

import { FinanceNav } from "./finance-nav";
import { FinancePeriodPicker } from "./finance-period-picker";

export function FinanceShell({
  period,
  title,
  subtitle,
  actions,
  periodIsolated = false,
  children,
}: {
  period: FinancePeriod;
  /** Título da vista. O cabeçalho do módulo é sempre "Financeiro". */
  title: string;
  subtitle?: string;
  /** Acção principal da vista, se houver. Uma só — ver a regra de acções. */
  actions?: ReactNode;
  /**
   * 🔴 A vista **não participa** no período do módulo.
   *
   * A casca não desenha o seletor nem as setas. Hoje só Pagamentos: abrir um
   * mês ali chama `getPayments` → `ensureMonth` → `insert`, e um controlo de
   * período tornaria isso um clique. Ver `PERIOD_ISOLATED_VIEWS`.
   */
  periodIsolated?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <Header
        title="Financeiro"
        subtitle={periodIsolated ? title : `${title} · ${formatFinancePeriod(period)}`}
      />

      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px] space-y-5">
        {/*
          1. FINANCE_V2_ALERT_SLOT — reservado, deliberadamente vazio.

          A especificação prevê avisos aqui, primeiro e fora da navegação. O
          candidato natural era o `PaymentsReminderBanner`, e a primeira versão
          desta casca montava-o. **Foi removido.**

          O banner é um componente de servidor que chama `getPaymentsReminder`,
          que chama `ensureMonth`, que faz `.insert(rows)`: renderizá-lo **gera**
          os pagamentos fixos do mês corrente. Montá-lo aqui levava esse efeito
          das duas superfícies que já o tinham (Dashboard e o Resumo antigo)
          para as sete vistas financeiras — a casca estaria a **ampliar** um
          auto-write em vez de o conter.

            PAYMENTS_REMINDER_CURRENT_IMPLEMENTATION = WRITE_CAPABLE
            FINANCE_SHELL_MOUNT                      = BLOCKED_UNTIL_READ_ONLY

          Nada foi posto no lugar: um aviso financeiro inventado seria pior do
          que nenhum. O slot volta a ser preenchido quando existir uma fonte de
          avisos sem efeito de escrita.

          O Dashboard mantém o banner — é anterior a esta PR e corrigi-lo é
          decisão do incidente financeiro, não desta casca.
        */}

        {/* 2. Período do módulo + acção principal da vista. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[22px] font-bold text-[#0F172A] tracking-[-0.02em] truncate">{title}</h2>
            {subtitle && <p className="text-[13px] text-[#64748B] mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            {periodIsolated ? (
              <p className="text-[12px] text-[#64748B] px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                Período gerido pela própria vista
              </p>
            ) : (
              <FinancePeriodPicker period={period} />
            )}
          </div>
        </div>

        {/* 3. Navegação única do módulo. */}
        <FinanceNav period={period} />

        {/* 4. Conteúdo da vista. */}
        <div className="space-y-5">{children}</div>
      </div>
    </div>
  );
}
