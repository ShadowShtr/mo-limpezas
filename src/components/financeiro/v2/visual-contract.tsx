// ============================================================================
// Contrato visual — como um componente diz "ainda não sei"
// ============================================================================
//
// Todo o painel do Financeiro V2 aceita a mesma forma:
//
//     { estado: "carregando" }                → esqueleto
//     { estado: "indisponivel", porque?: … }  → "Indisponível"
//     { estado: "erro", mensagem?: … }        → cartão de erro discreto
//     { estado: "pronto", dados: T }          → o painel a sério
//
// A razão de existir é uma só, e é a regra mais importante deste módulo:
//
//     🔴 null ≠ zero
//
// Um KPI a `0 €` num mês que nunca foi lançado diz ao dono que não tem nada a
// pagar. É falso, e é a leitura mais cara que este projecto já pagou — foi
// exactamente assim que um mês materializado por engano passou por completo.
//
// Repare-se que **não há forma de passar um número em falta**. `dados` só
// existe no estado `pronto`. Um componente não consegue, nem por descuido,
// desenhar zero quando o que tem é ausência: teria de mudar de estado, e isso
// lê-se no diff.
//
// O segundo motivo é prático. Metade dos painéis desta ronda — previsão de
// caixa, aging, receita por serviço, eficiência — ainda não tem fonte. Ficam
// estruturalmente completos e em `indisponivel`. Quando a PR B ligar o
// pipeline canónico, **muda-se a fonte, não o desenho**.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

export type Slot<T> =
  | { estado: "carregando" }
  | { estado: "indisponivel"; porque?: string }
  | { estado: "erro"; mensagem?: string; onRetry?: () => void }
  | { estado: "pronto"; dados: T };

/** Atalho para o caso comum: um valor que pode não existir. */
export function slotDe<T>(valor: T | null | undefined, porque?: string): Slot<T> {
  return valor === null || valor === undefined
    ? { estado: "indisponivel", porque }
    : { estado: "pronto", dados: valor };
}

// ─── Estados ─────────────────────────────────────────────────────────────────

/** Esqueleto com a forma do conteúdo — não um spinner no meio da página. */
export function Skeleton({ h = 16, w = "100%", className = "" }: { h?: number; w?: string | number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded-[10px] bg-[var(--finance-track)] ${className}`}
      style={{ height: h, width: w }}
    />
  );
}

/**
 * «Indisponível».
 *
 * Discreto de propósito: não é um erro nem um aviso, é apenas a verdade sobre
 * o que se sabe. Um bloco vermelho aqui ensinaria o utilizador a ignorá-lo.
 */
export function Indisponivel({ porque, compact = false }: { porque?: string; compact?: boolean }) {
  if (compact) {
    return <span className="text-[13px] font-medium text-[var(--finance-text-muted)]">Indisponível</span>;
  }
  return (
    <div className="py-8 text-center">
      <p className="text-[13px] font-medium text-[var(--finance-text-secondary)]">Indisponível</p>
      {porque && <p className="text-[12px] text-[var(--finance-text-muted)] mt-1 max-w-xs mx-auto">{porque}</p>}
    </div>
  );
}

export function ErroCard({ mensagem, onRetry }: { mensagem?: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 py-6 px-1">
      <CircleAlert className="w-4 h-4 shrink-0 mt-0.5 text-[var(--finance-red)]" aria-hidden />
      <div className="min-w-0">
        <p className="text-[13px] text-[var(--finance-text)]">
          {mensagem || "Não foi possível carregar estes dados."}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-[12px] font-medium text-[var(--finance-primary)] hover:underline"
          >
            Tentar novamente
          </button>
        )}
      </div>
    </div>
  );
}

export function VazioCompacto({ texto }: { texto: string }) {
  return <p className="py-8 text-center text-[13px] text-[var(--finance-text-muted)]">{texto}</p>;
}

/**
 * Desenha o estado certo, ou entrega os dados a quem sabe desenhá-los.
 *
 * Centralizar isto evita que cada painel invente a sua própria maneira de
 * dizer «não sei» — e evita que algum a esqueça e caia no zero.
 */
export function RenderSlot<T>({
  slot,
  esqueleto,
  children,
}: {
  slot: Slot<T>;
  esqueleto?: ReactNode;
  children: (dados: T) => ReactNode;
}) {
  switch (slot.estado) {
    case "carregando":
      return <>{esqueleto ?? <Skeleton h={96} />}</>;
    case "indisponivel":
      return <Indisponivel porque={slot.porque} />;
    case "erro":
      return <ErroCard mensagem={slot.mensagem} onRetry={slot.onRetry} />;
    case "pronto":
      return <>{children(slot.dados)}</>;
  }
}
