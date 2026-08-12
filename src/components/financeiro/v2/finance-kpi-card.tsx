// ============================================================================
// KPI — ícone em círculo pastel, rótulo pequeno, número grande
// ============================================================================
//
// Baixo e largo (105–115px), para os cinco caberem numa linha limpa e sobrar
// altura para o gráfico, que é o elemento dominante da página.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { FinanceCard, IconCircle } from "./finance-card";
import { Indisponivel, Skeleton, type Slot } from "./visual-contract";

export type KpiTom = "primary" | "green" | "orange" | "peach" | "red" | "neutral";

const TOM: Record<KpiTom, { bg: string; fg: string }> = {
  primary: { bg: "var(--finance-primary-soft)", fg: "var(--finance-primary)" },
  green:   { bg: "var(--finance-green-soft)",   fg: "var(--finance-green)" },
  orange:  { bg: "var(--finance-orange-soft)",  fg: "var(--finance-orange)" },
  peach:   { bg: "#FFF0E8",                     fg: "#F97316" },
  red:     { bg: "var(--finance-red-soft)",     fg: "var(--finance-red)" },
  neutral: { bg: "var(--finance-track)",        fg: "var(--finance-slate)" },
};

/**
 * A variação face ao período anterior.
 *
 * 🔴 A cor **não** é um juízo. Subir despesas não é «bom» por ser uma subida,
 * e descer receita não é «mau» por ser uma descida — isso depende do
 * indicador, e o sistema ainda não tem essa política definida.
 *
 * Por isso a polaridade é explícita: quem chama diz se subir é bom
 * (`polaridade="subir-bom"`), se subir é mau, ou — o caso por omissão — que
 * não há política, e então a seta mostra o facto em cinzento sem opinar.
 */
export type Polaridade = "subir-bom" | "subir-mau" | "factual";

export interface KpiComparacao {
  /** Variação em pontos percentuais. Sinal indica a direcção. */
  pct: number;
  etiqueta?: string;
  polaridade?: Polaridade;
}

function LinhaComparacao({ pct, etiqueta = "vs mês anterior", polaridade = "factual" }: KpiComparacao) {
  const subiu = pct >= 0;
  const cor =
    polaridade === "factual"
      ? "var(--finance-text-muted)"
      : (subiu && polaridade === "subir-bom") || (!subiu && polaridade === "subir-mau")
        ? "var(--finance-green)"
        : "var(--finance-red)";

  const Seta = subiu ? ArrowUp : ArrowDown;
  const valor = `${subiu ? "+" : ""}${pct.toLocaleString("pt-PT", { maximumFractionDigits: 1 })}%`;

  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-medium" style={{ color: cor }}>
      <Seta className="w-3 h-3" aria-hidden />
      {valor}
      <span className="text-[var(--finance-text-muted)] font-normal">{etiqueta}</span>
    </span>
  );
}

export function FinanceKpiCard({
  label,
  slot,
  icon,
  tom = "primary",
  comparacao,
  sufixo,
}: {
  label: string;
  /** O valor já formatado. `indisponivel` desenha "Indisponível", nunca zero. */
  slot: Slot<string>;
  icon: ReactNode;
  tom?: KpiTom;
  comparacao?: KpiComparacao;
  /** Texto pequeno à direita do valor — por exemplo o `· 22%` da Margem. */
  sufixo?: string;
}) {
  const t = TOM[tom];

  return (
    <FinanceCard className="min-h-[100px] flex items-center" padded={false}>
      <div className="flex items-start gap-3 px-4 py-3.5 w-full">
        <IconCircle bg={t.bg} fg={t.fg} size={36}>
          {icon}
        </IconCircle>

        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-[#344054] truncate">{label}</p>

          {slot.estado === "carregando" ? (
            <Skeleton h={24} w="70%" className="mt-1.5" />
          ) : slot.estado === "pronto" ? (
            <p className="mt-1 text-[22px] leading-none font-bold tracking-[-0.02em] text-[var(--finance-text)] truncate">
              {slot.dados}
              {sufixo && (
                <span className="ml-1.5 text-[13px] font-semibold text-[var(--finance-text-secondary)]">
                  {sufixo}
                </span>
              )}
            </p>
          ) : (
            <div className="mt-1">
              <Indisponivel compact />
            </div>
          )}

          {slot.estado === "pronto" && comparacao && (
            <div className="mt-1">
              <LinhaComparacao {...comparacao} />
            </div>
          )}
        </div>
      </div>
    </FinanceCard>
  );
}

export function FinanceKpiGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5">
      {children}
    </div>
  );
}
