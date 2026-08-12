// ============================================================================
// Atenção — a coluna à direita do gráfico
// ============================================================================
//
// Uma lista curta de coisas accionáveis, cada uma com destino. Serve de
// contrapeso ao gráfico: à esquerda o que aconteceu, à direita o que fazer.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { FinanceCard, IconCircle, SectionHeader } from "./finance-card";
import { VazioCompacto } from "./visual-contract";
import type { KpiTom } from "./finance-kpi-card";

const TOM: Record<KpiTom, { bg: string; fg: string }> = {
  primary: { bg: "var(--finance-primary-soft)", fg: "var(--finance-primary)" },
  green:   { bg: "var(--finance-green-soft)",   fg: "var(--finance-green)" },
  orange:  { bg: "var(--finance-orange-soft)",  fg: "var(--finance-orange)" },
  peach:   { bg: "#FFF0E8",                     fg: "#F97316" },
  red:     { bg: "var(--finance-red-soft)",     fg: "var(--finance-red)" },
  neutral: { bg: "var(--finance-track)",        fg: "var(--finance-slate)" },
};

export interface AtencaoItem {
  id: string;
  icon: ReactNode;
  tom: KpiTom;
  titulo: string;
  subtexto: string;
  href?: string;
}

export function FinanceAttentionPanel({ itens }: { itens: AtencaoItem[] }) {
  return (
    <FinanceCard className="h-full flex flex-col">
      <SectionHeader title="Atenção" />

      {itens.length === 0 ? (
        // Não ter nada a assinalar é uma boa notícia, e é assim que se diz.
        <VazioCompacto texto="Nada a assinalar neste período." />
      ) : (
        <div className="-mx-1">
          {itens.map((it, i) => {
            const t = TOM[it.tom];
            const linha = (
              <div className="flex items-center gap-3 px-1 py-3 min-w-0">
                <IconCircle bg={t.bg} fg={t.fg} size={34}>
                  {it.icon}
                </IconCircle>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-[var(--finance-text)] truncate">{it.titulo}</p>
                  <p className="text-[12px] text-[var(--finance-text-muted)] truncate">{it.subtexto}</p>
                </div>
                {it.href && (
                  <ChevronRight className="w-4 h-4 shrink-0 text-[var(--finance-text-muted)]" aria-hidden />
                )}
              </div>
            );

            return (
              <div
                key={it.id}
                className={i > 0 ? "border-t border-[var(--finance-divider)]" : ""}
              >
                {it.href ? (
                  <a href={it.href} className="block rounded-[12px] transition-colors hover:bg-[var(--finance-surface-soft)]">
                    {linha}
                  </a>
                ) : (
                  linha
                )}
              </div>
            );
          })}
        </div>
      )}
    </FinanceCard>
  );
}
