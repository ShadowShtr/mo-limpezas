// ============================================================================
// Faixa de alertas — um cartão horizontal, logo abaixo da navegação
// ============================================================================
//
// Um cartão só, com os itens lado a lado e divisores entre eles. Três cartões
// separados pesariam mais e diriam menos.
//
// 🔴 Um alerta sem fonte real **não aparece**. Itens sem fonte são omitidos e
//    o espaço redistribui-se pelos que existem — um aviso financeiro inventado
//    é pior do que aviso nenhum.
//
//    Quando não sobra nenhum, a faixa não desaparece: diz que está tudo em
//    ordem. Uma barra ausente deixa a dúvida entre "não há alertas" e "isto
//    partiu"; o silêncio explícito responde.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

import { FinanceCard, IconCircle } from "./finance-card";
import type { KpiTom } from "./finance-kpi-card";

const TOM: Record<KpiTom, { bg: string; fg: string }> = {
  primary: { bg: "var(--finance-primary-soft)", fg: "var(--finance-primary)" },
  green:   { bg: "var(--finance-green-soft)",   fg: "var(--finance-green)" },
  orange:  { bg: "var(--finance-orange-soft)",  fg: "var(--finance-orange)" },
  peach:   { bg: "#FFF0E8",                     fg: "#F97316" },
  red:     { bg: "var(--finance-red-soft)",     fg: "var(--finance-red)" },
  neutral: { bg: "var(--finance-track)",        fg: "var(--finance-slate)" },
};

export interface AlertaItem {
  id: string;
  icon: ReactNode;
  tom: KpiTom;
  titulo: string;
  subtexto: string;
  href?: string;
}

export function FinanceAlertStrip({ itens }: { itens: AlertaItem[] }) {
  // Sem alertas, a faixa mostra-se na mesma — mas diz que não há nada, em vez
  // de desaparecer. São coisas diferentes: uma barra ausente deixa a dúvida
  // ("não há alertas, ou o painel partiu?"), e o silêncio explícito responde.
  //
  // 🔴 O que não pode acontecer é preencher-se com números para parecer viva.
  if (itens.length === 0) {
    return (
      <FinanceCard>
        <div className="flex items-center gap-3">
          <IconCircle bg="var(--finance-green-soft)" fg="var(--finance-green)" size={34}>
            <ShieldCheck className="w-4 h-4" />
          </IconCircle>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium text-[var(--finance-text)]">
              Sem alertas financeiros neste período
            </p>
            <p className="text-[12px] text-[var(--finance-text-muted)]">
              Nada vencido, nada por faturar e nada a vencer nos próximos dias.
            </p>
          </div>
        </div>
      </FinanceCard>
    );
  }

  return (
    <FinanceCard padded={false}>
      <div className="flex flex-col sm:flex-row">
        {itens.map((it, i) => {
          const t = TOM[it.tom];
          const conteudo = (
            <div className="flex items-center gap-3 px-5 py-4 min-w-0">
              <IconCircle bg={t.bg} fg={t.fg} size={38}>
                {it.icon}
              </IconCircle>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[var(--finance-text)] truncate">{it.titulo}</p>
                <p className="text-[12px] text-[var(--finance-text-muted)] truncate">{it.subtexto}</p>
              </div>
            </div>
          );

          return (
            <div
              key={it.id}
              className={[
                "flex-1 min-w-0",
                i > 0 ? "border-t sm:border-t-0 sm:border-l border-[var(--finance-divider)]" : "",
              ].join(" ")}
            >
              {it.href ? (
                <a
                  href={it.href}
                  className="block rounded-[18px] transition-colors hover:bg-[var(--finance-surface-soft)]"
                >
                  {conteudo}
                </a>
              ) : (
                conteudo
              )}
            </div>
          );
        })}
      </div>
    </FinanceCard>
  );
}
