// ============================================================================
// Primitivos visuais do Financeiro V2
// ============================================================================
//
// Uma camada de **apresentação**, e só isso. Nenhum destes componentes lê,
// escreve, calcula ou formata dinheiro: recebem o que já existe e desenham.
//
// Existem porque as sete vistas financeiras somam mais de 5000 linhas de
// cliente. Reescrevê-las era a forma mais rápida de partir funcionalidade que
// já funciona. Envolver e reorganizar não é.
//
// 🔴 Regra: `UNAVAILABLE` nunca vira `0 €`. Um KPI sem fonte mostra
//    «Indisponível» — ausência de dado não é ausência de valor.
// ============================================================================

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

// ─── Cartão ───────────────────────────────────────────────────────────────────

export function FinanceCard({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-2xl border border-[#EDF0EE] shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.03)] ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
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
        <h3 className="text-[14px] font-semibold text-[#0F172A] truncate">{title}</h3>
        {hint && <p className="text-[12px] text-[#94A3B8] mt-0.5">{hint}</p>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}

// ─── KPI ──────────────────────────────────────────────────────────────────────

export type KpiTone = "neutral" | "positive" | "warning" | "danger";

const TONE: Record<KpiTone, { value: string; chip: string }> = {
  neutral: { value: "text-[#0F172A]", chip: "bg-[#F1F5F9] text-[#475569]" },
  positive: { value: "text-[#15803D]", chip: "bg-[#F0FDF4] text-[#15803D]" },
  warning: { value: "text-[#B45309]", chip: "bg-[#FFFBEB] text-[#B45309]" },
  danger: { value: "text-[#B91C1C]", chip: "bg-[#FEF2F2] text-[#B91C1C]" },
};

/**
 * Um número grande com um rótulo pequeno.
 *
 * `value == null` significa **sem fonte**, e mostra «Indisponível». É
 * deliberado que não haja forma de passar zero por omissão: um zero inventado
 * num painel financeiro lê-se como «não há nada a pagar», que é a leitura mais
 * cara que este projecto já pagou.
 */
export function Kpi({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string | null;
  sub?: ReactNode;
  tone?: KpiTone;
  icon?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <FinanceCard className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-[#64748B] uppercase tracking-[0.04em]">{label}</p>
        {icon && <span className="text-[#CBD5E1]">{icon}</span>}
      </div>
      {value === null ? (
        <p className="text-[15px] font-medium text-[#94A3B8] leading-tight py-1.5">Indisponível</p>
      ) : (
        <p className={`text-[26px] leading-none font-bold tracking-[-0.02em] ${t.value}`}>{value}</p>
      )}
      {sub && <div className="text-[12px] text-[#94A3B8] leading-snug">{sub}</div>}
    </FinanceCard>
  );
}

export function KpiChip({ children, tone = "neutral" }: { children: ReactNode; tone?: KpiTone }) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium ${TONE[tone].chip}`}>
      {children}
    </span>
  );
}

export function KpiGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 | 5 }) {
  const c = cols === 3 ? "lg:grid-cols-3" : cols === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";
  return <div className={`grid grid-cols-1 sm:grid-cols-2 ${c} gap-4`}>{children}</div>;
}

// ─── Abas locais ──────────────────────────────────────────────────────────────

/**
 * Abas de **filtro local**, sobre dados já carregados.
 *
 * Trocar de aba não vai à base, não muda o mês e não dispara nenhuma mutação —
 * é a mesma resposta, mostrada por partes.
 */
export function LocalTabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; count?: number }[];
}) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F1F5F9]">
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            aria-pressed={active}
            className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
              active ? "bg-white text-[#0F172A] shadow-sm" : "text-[#64748B] hover:text-[#0F172A]"
            }`}
          >
            {it.label}
            {typeof it.count === "number" && (
              <span className={`ml-1.5 text-[11px] ${active ? "text-[#94A3B8]" : "text-[#CBD5E1]"}`}>
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Menu de linha ────────────────────────────────────────────────────────────

export interface RowAction {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * O «⋯» de uma linha de tabela.
 *
 * Serve a regra dos botões: uma acção principal fica visível, as restantes
 * recolhem-se aqui. **Recolher não é remover** — nenhuma funcionalidade
 * existente pode desaparecer só porque não cabia no desenho novo.
 */
export function RowMenu({ actions, label = "Mais ações" }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const botaoRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const LARGURA = 180;
  const MARGEM = 8;

  /**
   * Calcula a posição a partir do botão, em coordenadas de viewport.
   *
   * Vira para cima quando não há espaço em baixo — na última linha da tabela
   * é o caso normal — e encosta-se à margem quando não há espaço à direita.
   */
  const posicionar = useCallback(() => {
    const b = botaoRef.current?.getBoundingClientRect();
    if (!b) return;
    const altura = menuRef.current?.offsetHeight ?? 0;

    const cabeEmBaixo = b.bottom + altura + MARGEM <= window.innerHeight;
    const top = cabeEmBaixo ? b.bottom + 4 : Math.max(MARGEM, b.top - altura - 4);

    const desejado = b.right - LARGURA;
    const left = Math.min(
      Math.max(MARGEM, desejado),
      Math.max(MARGEM, window.innerWidth - LARGURA - MARGEM),
    );
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => { if (open) posicionar(); }, [open, posicionar]);

  useEffect(() => {
    if (!open) return;
    const fora = (e: MouseEvent) => {
      const alvo = e.target as Node;
      if (botaoRef.current?.contains(alvo)) return;
      if (menuRef.current?.contains(alvo)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // O menu vive fora do contentor que faz scroll: se esse contentor rolar,
    // a posição calculada deixa de servir. Fechar é mais honesto do que
    // deixá-lo a flutuar longe da linha a que pertence.
    const aoRolar = () => setOpen(false);

    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", posicionar);
    window.addEventListener("scroll", aoRolar, true);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", posicionar);
      window.removeEventListener("scroll", aoRolar, true);
    };
  }, [open, posicionar]);

  const uteis = actions.filter((a) => !a.disabled);
  if (uteis.length === 0) return null;

  /**
   * 🔴 O menu é desenhado no `body`, não dentro da linha.
   *
   *    Estava `absolute` dentro do `TableWrap`, que tem `overflow-x-auto`.
   *    Abrir o menu aumentava o conteúdo do contentor: aparecia uma barra de
   *    rolagem horizontal, a tabela mexia-se, e nas últimas linhas o menu
   *    ficava cortado.
   *
   *    Um `overflow: visible` no contentor resolveria o corte e estragaria o
   *    scroll horizontal que a tabela precisa em ecrãs estreitos. Sair do
   *    contentor resolve as duas coisas: o menu flutua por cima e as
   *    dimensões da tabela não mudam.
   */
  const menu = open && pos ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, width: LARGURA }}
      className="z-[60] py-1 bg-white rounded-xl border border-[#E2E8F0] shadow-lg"
    >
      {uteis.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          onClick={() => { setOpen(false); a.onSelect(); }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left transition-colors ${
            a.danger ? "text-[#B91C1C] hover:bg-[#FEF2F2]" : "text-[#334155] hover:bg-[#F8FAFC]"
          }`}
        >
          {a.icon && <span className="shrink-0">{a.icon}</span>}
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="inline-block">
      <button
        ref={botaoRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {menu}
    </div>
  );
}

// ─── Tabela ───────────────────────────────────────────────────────────────────

/** Envolve uma tabela larga. O corpo da página nunca faz scroll horizontal. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto -mx-5 px-5">{children}</div>;
}

export function Th({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" | "center" }) {
  return (
    <th
      className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#94A3B8] whitespace-nowrap text-${align}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return <td className={`px-3 py-2.5 text-[13px] text-[#334155] text-${align} ${className}`}>{children}</td>;
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-t border-[#F1F5F9] hover:bg-[#FAFBFA] transition-colors">{children}</tr>;
}

// ─── Estados ──────────────────────────────────────────────────────────────────

/**
 * O vazio, dito como vazio.
 *
 * Nunca insinuar que algo foi apagado, e nunca deixar um zero ocupar o lugar de
 * «ainda não foi lançado».
 */
export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="py-12 px-6 text-center">
      {icon && <div className="flex justify-center mb-3 text-[#CBD5E1]">{icon}</div>}
      <p className="text-[14px] font-medium text-[#475569]">{title}</p>
      {hint && <p className="text-[13px] text-[#94A3B8] mt-1 max-w-md mx-auto">{hint}</p>}
    </div>
  );
}

export function StatusPill({ tone, children }: { tone: KpiTone; children: ReactNode }) {
  const cls: Record<KpiTone, string> = {
    neutral: "bg-[#F1F5F9] text-[#475569]",
    positive: "bg-[#F0FDF4] text-[#15803D]",
    warning: "bg-[#FFFBEB] text-[#B45309]",
    danger: "bg-[#FEF2F2] text-[#B91C1C]",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${cls[tone]}`}>
      {children}
    </span>
  );
}

/** Acção principal de uma vista. Uma só, verde, visível. */
export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[var(--color-primary)] text-white text-[13px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50 transition-colors"
    >
      {children}
    </button>
  );
}
