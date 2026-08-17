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
import type { FinancePeriod } from "@/lib/finance-period";

import { FinanceNav } from "./finance-nav";
import { FinancePeriodPicker } from "./finance-period-picker";
import { PeriodCloseControls } from "./period-close-controls";

export function FinanceShell({
  period,
  title,
  subtitle,
  actions,
  periodIsolated = false,
  periodStatus,
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
  /**
   * Estado do fechamento mensal, já lido por quem chama.
   *
   * 🔴 A casca **não** o vai buscar. Continua a ser um componente de servidor
   *    sem efeitos: renderizá-la não lê nem escreve nada. Quem passa isto é a
   *    página, que já faz as suas leituras.
   *
   * `undefined` desenha a casca como antes — nenhuma pastilha, nenhum botão.
   */
  periodStatus?: {
    status: "open" | "closed";
    podeGerir: boolean;
    closedByName: string | null;
    reopenReason: string | null;
    nomePeriodo: string;
  };
  children: ReactNode;
}) {
  return (
    <div className="bg-[var(--finance-bg)] min-h-screen">
      {/*
        🔴 Um cabeçalho, não dois.

        Havia o `Header` da aplicação a dizer "Financeiro · Resumo · Agosto
        2026" e, logo abaixo, o título da vista a repetir "Resumo". Dois
        cabeçalhos empilhados, a dizer o mesmo, a roubar altura ao conteúdo — e
        a referência aprovada tem um só.

        O `Header` global fica, porque transporta o sino de notificações e a
        navegação móvel, mas deixa de repetir a vista: o título grande e o
        período vivem aqui em baixo, juntos, como na referência.
      */}
      <Header title="Financeiro" subtitle="Resumo financeiro do módulo" />

      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1440px] space-y-4">
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

        {/*
          2. Navegação + período, na mesma linha.

          🔴 O título da vista saiu daqui. Na referência aprovada não existe: o
          cabeçalho diz "Financeiro" e é a **pastilha activa da barra** que diz
          em que vista se está. Ter um `<h2>Resumo</h2>` logo por baixo de uma
          pastilha que já diz "Resumo" é a terceira vez que a mesma palavra
          aparece no mesmo ecrã, e rouba altura ao conteúdo.

          O `title` continua a existir na assinatura porque as sete vistas o
          passam e porque alimenta a acessibilidade — mas não se desenha.
        */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FinanceNav period={period} />
          <div className="flex items-center gap-2 shrink-0">
            {actions}
            {periodStatus && (
              <PeriodCloseControls
                year={period.year}
                month={period.month}
                nomePeriodo={periodStatus.nomePeriodo}
                status={periodStatus.status}
                podeGerir={periodStatus.podeGerir}
                closedByName={periodStatus.closedByName}
                reopenReason={periodStatus.reopenReason}
              />
            )}
            {periodIsolated ? (
              <p className="text-[12px] text-[var(--finance-text-secondary)] px-3 py-2 rounded-[10px] bg-[var(--finance-surface-soft)] border border-[var(--finance-border)]">
                Período gerido pela própria vista
              </p>
            ) : (
              <FinancePeriodPicker period={period} />
            )}
          </div>
        </div>
        <h2 className="sr-only">{title}</h2>
        {subtitle && <p className="sr-only">{subtitle}</p>}

        {/* 4. Conteúdo da vista. */}
        <div className="space-y-5">{children}</div>
      </div>
    </div>
  );
}
