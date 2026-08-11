"use client";

// ============================================================================
// Seletor de período do Financeiro — Financeiro V2, PR A
// ============================================================================
//
// Controla o **módulo inteiro**, não o Resumo. Escreve o mês na URL
// (`?mes=YYYY-MM`) e a navegação leva-o para as sete vistas.
//
// 🔴 Trocar de mês é **read-only**: substitui o parâmetro na rota actual e mais
//    nada. Não gera pagamentos, não recalcula folha, não cria cobranças, não
//    chama `ensureMonth`. Ver `docs/FINANCEIRO-V2-PR-A-SHELL.md`.
// ============================================================================

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import {
  type FinancePeriod,
  FINANCE_PERIOD_PARAM,
  currentFinancePeriod,
  formatFinancePeriod,
  monthName,
  shiftFinancePeriod,
} from "@/lib/finance-period";

export function FinancePeriodPicker({ period }: { period: FinancePeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [aberto, setAberto] = useState(false);
  const [ano, setAno] = useState(period.year);
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    function fora(e: MouseEvent) {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setAberto(false);
    }
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);

  /**
   * Navega para o mesmo caminho com outro mês.
   *
   * `replace` e não `push`: percorrer meses não deve encher o histórico de
   * forma a tornar o botão "voltar" inútil.
   */
  function irPara(novo: FinancePeriod) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(FINANCE_PERIOD_PARAM, novo.key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setAberto(false);
  }

  const hoje = currentFinancePeriod();

  return (
    <div className="flex items-center gap-1" ref={caixa}>
      <button
        type="button"
        onClick={() => irPara(shiftFinancePeriod(period, -1))}
        aria-label="Mês anterior"
        className="p-1.5 rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0F172A] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
      >
        <ChevronLeft className="w-4 h-4" aria-hidden />
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => { setAno(period.year); setAberto((v) => !v); }}
          aria-haspopup="dialog"
          aria-expanded={aberto}
          className="inline-flex items-center gap-2 rounded-xl border border-[#E2E8F0] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
        >
          {formatFinancePeriod(period)}
          <ChevronDown className={`w-4 h-4 text-[#94A3B8] transition-transform ${aberto ? "rotate-180" : ""}`} aria-hidden />
        </button>

        {aberto && (
          <div
            role="dialog"
            aria-label="Escolher período"
            className="absolute right-0 z-50 mt-2 w-[260px] rounded-2xl border border-[#E2E8F0] bg-white p-3 shadow-lg"
          >
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setAno((a) => a - 1)}
                aria-label="Ano anterior"
                className="p-1 rounded-lg text-[#64748B] hover:bg-[#F1F5F9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden />
              </button>
              <span className="text-[13px] font-bold text-[#0F172A]">{ano}</span>
              <button
                type="button"
                onClick={() => setAno((a) => a + 1)}
                aria-label="Ano seguinte"
                className="p-1 rounded-lg text-[#64748B] hover:bg-[#F1F5F9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
              >
                <ChevronRight className="w-4 h-4" aria-hidden />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const seleccionado = ano === period.year && m === period.month;
                const eHoje = ano === hoje.year && m === hoje.month;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => irPara({ year: ano, month: m, key: `${ano}-${String(m).padStart(2, "0")}` })}
                    aria-current={seleccionado ? "true" : undefined}
                    className={[
                      "rounded-lg px-2 py-2 text-[12px] font-semibold transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]",
                      seleccionado
                        ? "bg-[#16A34A] text-white"
                        : eHoje
                          ? "text-[#16A34A] bg-[#F0FDF4] hover:bg-[#DCFCE7]"
                          : "text-[#475569] hover:bg-[#F1F5F9]",
                    ].join(" ")}
                  >
                    {monthName(m).slice(0, 3)}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => irPara(hoje)}
              className="mt-2 w-full rounded-lg py-2 text-[12px] font-semibold text-[#16A34A] hover:bg-[#F0FDF4] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
            >
              Ir para {formatFinancePeriod(hoje)}
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => irPara(shiftFinancePeriod(period, 1))}
        aria-label="Mês seguinte"
        className="p-1.5 rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0F172A] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]"
      >
        <ChevronRight className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
}
