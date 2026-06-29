"use client";

import { useState, useRef, useEffect } from "react";
import {
  format, addMonths, subMonths, startOfMonth, endOfMonth,
  startOfWeek, endOfWeek, eachDayOfInterval, isSameDay, isSameMonth,
} from "date-fns";
import { pt } from "date-fns/locale";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

interface Props {
  selectedDate: Date;
  today: Date | null;
  onSelect: (date: Date) => void;
}

/** Botão com a data selecionada que abre um calendário mensal para saltar para qualquer dia. */
export function MonthDatePicker({ selectedDate, today, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(selectedDate));
  const ref = useRef<HTMLDivElement>(null);

  // Ao abrir, posiciona o calendário no mês da data selecionada
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setViewMonth(startOfMonth(selectedDate));
  }, [open, selectedDate]);

  // Fechar ao clicar fora ou com Esc
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const gridStart = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 0 });
  const gridEnd   = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  function handlePick(day: Date) {
    setOpen(false);
    onSelect(day);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Escolher data"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors"
      >
        <CalendarDays className="w-4 h-4 text-[var(--color-text-sub)]" />
        {format(selectedDate, "dd/MM/yyyy")}
      </button>

      {open && (
        <div className="absolute left-0 mt-2 z-50 w-[320px] bg-white rounded-xl shadow-2xl border border-[var(--color-border)] p-4">
          {/* Cabeçalho do mês */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setViewMonth((m) => subMonths(m, 1))}
              title="Mês anterior"
              className="p-1.5 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-[var(--color-text-main)] capitalize">
              {format(viewMonth, "MMMM yyyy", { locale: pt })}
            </span>
            <button
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              title="Mês seguinte"
              className="p-1.5 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Dias da semana */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-center text-[11px] font-semibold text-[var(--color-text-muted)] py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Grelha de dias */}
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((day) => {
              const inMonth = isSameMonth(day, viewMonth);
              const isSel   = isSameDay(day, selectedDate);
              const isTody  = today !== null && isSameDay(day, today);
              return (
                <button
                  key={day.toISOString()}
                  onClick={() => handlePick(day)}
                  className={`h-9 w-full rounded-full text-sm font-medium transition-colors flex items-center justify-center
                    ${isSel
                      ? "bg-[var(--color-primary)] text-white font-semibold"
                      : isTody
                        ? "bg-[var(--color-background)] text-[var(--color-text-main)] ring-1 ring-[var(--color-border)]"
                        : inMonth
                          ? "text-[var(--color-text-main)] hover:bg-[var(--color-background)]"
                          : "text-[var(--color-text-muted)] opacity-50 hover:bg-[var(--color-background)]"
                    }`}
                >
                  {format(day, "d")}
                </button>
              );
            })}
          </div>

          {/* Atalho Hoje */}
          {today && (
            <button
              onClick={() => handlePick(today)}
              className="w-full mt-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              Hoje
            </button>
          )}
        </div>
      )}
    </div>
  );
}
