"use client";

import { useState } from "react";
import { X, Loader2, AlertCircle } from "lucide-react";
import { adjustPayrollRecord, type PayrollRecord } from "@/app/actions/payroll";

interface Props {
  record: PayrollRecord;
  onClose: () => void;
  onSaved: (updated: PayrollRecord) => void;
}

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

export function PayrollEditSheet({ record, onClose, onSaved }: Props) {
  const [otherAdd, setOtherAdd] = useState(record.other_additions.toString());
  const [otherDed, setOtherDed] = useState(record.other_deductions.toString());
  const [notes,    setNotes]    = useState(record.notes ?? "");
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const addVal = parseFloat(otherAdd) || 0;
  const dedVal = parseFloat(otherDed) || 0;

  const previewNet = Math.round(
    (record.gross_salary + record.meal_allowance + record.overtime_bonus
      + addVal - record.absence_deductions - dedVal) * 100,
  ) / 100;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await adjustPayrollRecord(record.id, {
      other_additions:  addVal,
      other_deductions: dedVal,
      notes:            notes || undefined,
    });
    if (res.ok) {
      onSaved({
        ...record,
        other_additions:  addVal,
        other_deductions: dedVal,
        net_salary:       previewNet,
        notes:            notes || null,
      });
    } else {
      setError(res.error ?? "Erro ao guardar.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">Ajustar registo</h2>
            <p className="text-xs text-[var(--color-text-muted)]">{record.full_name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Resumo atual */}
        <div className="px-6 py-4 bg-[var(--color-background)] border-b border-[var(--color-border)]">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <SummaryLine label="Salário bruto"    value={fmtEur(record.gross_salary)} />
            <SummaryLine label="Sub. alimentação" value={fmtEur(record.meal_allowance)} />
            <SummaryLine label="Horas extra"      value={fmtEur(record.overtime_bonus)} />
            <SummaryLine label="Desc. faltas"     value={fmtEur(record.absence_deductions)} danger />
          </div>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Acréscimos manuais (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— subsídio, prémio, etc.</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otherAdd}
              onChange={(e) => setOtherAdd(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Descontos manuais (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— adiantamento, etc.</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otherDed}
              onChange={(e) => setOtherDed(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Notas</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Observações para este mês..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          {/* Preview líquido */}
          <div className="p-4 rounded-xl bg-[var(--color-primary-light)] border border-[var(--color-primary)] border-opacity-30">
            <p className="text-xs text-[var(--color-text-muted)] mb-1">Total líquido (pré-visualização)</p>
            <p className="text-2xl font-bold text-[var(--color-primary)]">{fmtEur(previewNet)}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {fmtEur(record.gross_salary)} + {fmtEur(record.meal_allowance)} + {fmtEur(record.overtime_bonus)} + {fmtEur(addVal)} − {fmtEur(record.absence_deductions)} − {fmtEur(dedVal)}
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-4 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Guardar
          </button>
        </div>
      </div>
    </>
  );
}

function SummaryLine({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className={`font-medium ${danger ? "text-red-600" : "text-[var(--color-text-main)]"}`}>{value}</p>
    </div>
  );
}
