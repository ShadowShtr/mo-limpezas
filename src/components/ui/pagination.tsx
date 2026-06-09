"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE_OPTIONS = [10, 20, 30];

export interface PaginationState<T> {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  pageItems: T[];
  setPage: (n: number) => void;
  setPageSize: (n: number) => void;
}

/**
 * Hook de paginação no cliente. Mostra `defaultPageSize` itens por página (10 por defeito).
 * Mantém a página dentro de limites mesmo que a lista encolha.
 */
export function usePagination<T>(items: T[], defaultPageSize = 10): PaginationState<T> {
  const [pageSize, setPageSizeRaw] = useState(defaultPageSize);
  const [page, setPageRaw] = useState(1);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );

  function setPage(n: number) {
    setPageRaw(Math.min(Math.max(1, n), totalPages));
  }
  function setPageSize(n: number) {
    setPageSizeRaw(n);
    setPageRaw(1);
  }

  return { page: safePage, pageSize, totalPages, total: items.length, pageItems, setPage, setPageSize };
}

interface PaginationProps {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  setPage: (n: number) => void;
  setPageSize: (n: number) => void;
  /** Esconde o seletor de tamanho se a lista couber numa página de 10. */
  hideWhenSinglePage?: boolean;
}

/** Barra de paginação: seletor de itens por página + navegação. */
export function Pagination({
  page, pageSize, totalPages, total, setPage, setPageSize, hideWhenSinglePage = false,
}: PaginationProps) {
  if (total === 0) return null;
  if (hideWhenSinglePage && total <= PAGE_SIZE_OPTIONS[0]) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)]">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span>Mostrar</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="rounded-lg border border-[var(--color-border)] bg-white px-2 py-1 text-xs text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span className="tabular-nums">por página · {from}–{to} de {total}</span>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
          className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="px-2 text-xs font-medium text-[var(--color-text-sub)] tabular-nums">
          {page} / {totalPages}
        </span>
        <button
          onClick={() => setPage(page + 1)}
          disabled={page >= totalPages}
          className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página seguinte"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
