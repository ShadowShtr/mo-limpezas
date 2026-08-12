// ============================================================================
// Cartão — a superfície base do Financeiro V2
// ============================================================================
//
// Branco domina, a borda é quase invisível e a sombra mal se nota. É isso que
// separa a aparência de "software administrativo" da de um produto — não são
// mais elementos, são menos linhas a competir com os dados.
//
// Sem lógica, sem dados, sem Supabase. Recebe e desenha.
// ============================================================================

import type { ReactNode } from "react";

export const CARD_SHADOW = "0 1px 2px rgba(16,24,40,.03), 0 2px 8px rgba(16,24,40,.035)";
export const CARD_SHADOW_HOVER = "0 4px 16px rgba(16,24,40,.06)";

export function FinanceCard({
  children,
  className = "",
  padded = true,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  interactive?: boolean;
}) {
  return (
    <div
      className={[
        "bg-[var(--finance-surface)] border border-[var(--finance-border)] rounded-[18px]",
        padded ? "p-5" : "",
        interactive ? "transition-shadow duration-150 hover:shadow-[0_4px_16px_rgba(16,24,40,.06)]" : "",
        className,
      ].join(" ")}
      style={{ boxShadow: CARD_SHADOW }}
    >
      {children}
    </div>
  );
}

/**
 * O ícone dentro de um círculo pastel.
 *
 * É o detalhe que mais distingue esta interface da anterior: cada indicador
 * importante tem um ícone contido, em vez de ícones soltos no meio do texto.
 */
export function IconCircle({
  children,
  bg,
  fg,
  size = 36,
}: {
  children: ReactNode;
  bg: string;
  fg: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-full shrink-0"
      style={{ width: size, height: size, background: bg, color: fg }}
    >
      {children}
    </span>
  );
}

export function SectionHeader({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-[var(--finance-text)] truncate">{title}</h3>
        {hint && <p className="text-[12px] text-[var(--finance-text-muted)] mt-0.5">{hint}</p>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}
