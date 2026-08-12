// ============================================================================
// Faixa de alertas — um cartão horizontal, logo abaixo da navegação
// ============================================================================
//
// Um cartão só, com os itens lado a lado e divisores entre eles. Três cartões
// separados pesariam mais e diriam menos.
//
// 🔴 Um alerta sem fonte real **não aparece**. Não há aqui espaço para
//    "Dados ainda não disponíveis" a ocupar um terço da faixa: um aviso
//    financeiro inventado é pior do que aviso nenhum, e um aviso vazio ensina
//    a ignorar a faixa toda. Itens sem fonte são omitidos e o espaço
//    redistribui-se pelos que existem.
// ============================================================================

"use client";

import type { ReactNode } from "react";

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
  // Sem nada real para dizer, a faixa não existe. Não fica uma barra vazia a
  // ocupar o topo da página.
  if (itens.length === 0) return null;

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
