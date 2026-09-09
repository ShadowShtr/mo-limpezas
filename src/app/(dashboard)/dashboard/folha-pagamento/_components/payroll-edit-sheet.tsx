"use client";

import { useState } from "react";
import { X, Loader2, AlertCircle, Clock, Euro, Percent } from "lucide-react";
import { adjustPayrollRecord, type PayrollRecord } from "@/app/actions/payroll";

interface Props {
  record: PayrollRecord;
  onClose: () => void;
  onSaved: (updated: PayrollRecord) => void;
}

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="w-5 h-5 text-[var(--color-text-muted)]">{icon}</div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
    </div>
  );
}

function SummaryLine({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className={`font-medium text-sm ${danger ? "text-red-600" : "text-[var(--color-text-main)]"}`}>{value}</p>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] focus:border-transparent";

export function PayrollEditSheet({ record, onClose, onSaved }: Props) {
  // Campos de taxas
  const [hourlyRate,    setHourlyRate]    = useState(record.hourly_rate.toString());
  const mealPerDayInit = record.days_worked > 0 ? record.meal_allowance / record.days_worked : 9.6;
  const [mealDay,       setMealDay]       = useState(mealPerDayInit.toFixed(2));
  // Campos de horas
  const [workedHours,   setWorkedHours]   = useState(record.worked_hours.toString());
  const [overtimeHours, setOvertimeHours] = useState(record.overtime_hours.toString());
  const [absenceHours,  setAbsenceHours]  = useState(record.absence_hours.toString());
  const [daysWorked,    setDaysWorked]    = useState(record.days_worked.toString());
  // Desconto por falta (€)
  const [absenceDed,    setAbsenceDed]    = useState(record.absence_deductions.toString());
  // Vencimento base do mês
  const [baseSalary, setBaseSalary] = useState(record.base_salary.toString());
  // Líquido escrito à mão
  const [overrideOn,     setOverrideOn]     = useState(record.net_salary_override !== null);
  const [overrideValue,  setOverrideValue]  = useState(
    record.net_salary_override !== null ? record.net_salary_override.toString() : "",
  );
  const [overrideReason, setOverrideReason] = useState(record.net_salary_override_reason ?? "");
  // Ajustes manuais
  const [otherAdd, setOtherAdd] = useState(record.other_additions.toString());
  const [otherDed, setOtherDed] = useState(record.other_deductions.toString());
  const [notes,    setNotes]    = useState(record.notes ?? "");

  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  // Cálculo do preview em tempo real
  const hourlyRateVal    = parseFloat(hourlyRate)    || 0;
  const mealDayVal       = parseFloat(mealDay)       || 0;
  const workedHoursVal   = parseFloat(workedHours)   || 0;
  const overtimeHoursVal = parseFloat(overtimeHours) || 0;
  const daysWorkedVal    = parseInt(daysWorked)       || 0;
  const absenceDedVal    = parseFloat(absenceDed)    || 0;
  const addVal           = parseFloat(otherAdd)       || 0;
  const dedVal           = parseFloat(otherDed)       || 0;

  const baseSalaryVal    = parseFloat(baseSalary) || 0;
  const overrideVal      = parseFloat(overrideValue);
  const overrideValido   = overrideOn && Number.isFinite(overrideVal);

  // Com vencimento base, o bruto É o base. Mesma regra do servidor.
  const grossPreview    = baseSalaryVal > 0
    ? baseSalaryVal
    : Math.round(workedHoursVal * hourlyRateVal * 100) / 100;
  const mealPreview     = Math.round(daysWorkedVal * mealDayVal * 100) / 100;
  const otBonusPreview  = Math.round(overtimeHoursVal * hourlyRateVal * ((record.overtime_rate_pct ?? 25) / 100) * 100) / 100;
  const netCalculado    = Math.round(
    (grossPreview + mealPreview + otBonusPreview + addVal - absenceDedVal - dedVal) * 100,
  ) / 100;
  // O que se vai pagar: o escrito à mão, ou a conta.
  const previewNet      = overrideValido ? overrideVal : netCalculado;
  const diferenca       = Math.round((previewNet - netCalculado) * 100) / 100;
  const razaoEmFalta    = overrideValido && overrideReason.trim().length < 3;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (razaoEmFalta) {
      setError("Escreva porque é que o líquido difere do calculado.");
      setSaving(false);
      return;
    }

    const res = await adjustPayrollRecord(record.id, {
      base_salary:         baseSalaryVal,
      net_salary_override: overrideValido ? overrideVal : null,
      net_salary_override_reason: overrideValido ? overrideReason.trim() : null,
      hourly_rate:         hourlyRateVal,
      meal_allowance_day:  mealDayVal,
      worked_hours:        workedHoursVal,
      overtime_hours:      overtimeHoursVal,
      absence_hours:       parseFloat(absenceHours) || 0,
      days_worked:         daysWorkedVal,
      absence_deductions:  absenceDedVal,
      other_additions:     addVal,
      other_deductions:    dedVal,
      notes:               notes || undefined,
    });

    if (res.ok) {
      onSaved({
        ...record,
        base_salary:         baseSalaryVal,
        net_salary_override: overrideValido ? overrideVal : null,
        net_salary_override_reason: overrideValido ? overrideReason.trim() : null,
        hourly_rate:         hourlyRateVal,
        worked_hours:        workedHoursVal,
        overtime_hours:      overtimeHoursVal,
        absence_hours:       parseFloat(absenceHours) || 0,
        days_worked:         daysWorkedVal,
        gross_salary:        grossPreview,
        meal_allowance:      mealPreview,
        overtime_bonus:      otBonusPreview,
        absence_deductions:  absenceDedVal,
        other_additions:     addVal,
        other_deductions:    dedVal,
        net_salary:          previewNet,
        notes:               notes || null,
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

        {/* Resumo calculado do registo original */}
        <div className="px-6 py-4 bg-[var(--color-background)] border-b border-[var(--color-border)]">
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Valores atuais (antes de guardar)</p>
          <div className="grid grid-cols-2 gap-3">
            <SummaryLine label="Salário bruto"    value={fmtEur(record.gross_salary)} />
            <SummaryLine label="Sub. alimentação" value={fmtEur(record.meal_allowance)} />
            <SummaryLine label="Bónus horas extra" value={fmtEur(record.overtime_bonus)} />
            <SummaryLine label="Desc. faltas"     value={fmtEur(record.absence_deductions)} danger />
          </div>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Secção: Vencimento base */}
          <SectionLabel icon={<Euro className="w-4 h-4" />} label="Vencimento base" />

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Vencimento base do mês (€)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={baseSalary}
              onChange={(e) => setBaseSalary(e.target.value)}
              className={inputCls}
              placeholder="0,00"
            />
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
              {baseSalaryVal > 0
                ? "O bruto é este valor. As horas abaixo continuam a contar para assiduidade e horas extra, mas não mexem no bruto."
                : "A zero, o bruto é calculado pelas horas × €/hora, como antes."}
            </p>
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: Taxas */}
          <SectionLabel icon={<Percent className="w-4 h-4" />} label="Taxas" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                €/hora
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Sub. alimentação/dia (€)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={mealDay}
                onChange={(e) => setMealDay(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: Correções de Horas */}
          <SectionLabel icon={<Clock className="w-4 h-4" />} label="Correções de Horas" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Horas trabalhadas
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={workedHours}
                onChange={(e) => setWorkedHours(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Horas extra
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={overtimeHours}
                onChange={(e) => setOvertimeHours(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Dias trabalhados
                <span className="text-[var(--color-text-muted)] font-normal ml-1">— afeta sub. alim.</span>
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={daysWorked}
                onChange={(e) => setDaysWorked(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Horas de falta
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={absenceHours}
                onChange={(e) => setAbsenceHours(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Descontos por falta (€)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={absenceDed}
              onChange={(e) => setAbsenceDed(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: Ajustes Manuais */}
          <SectionLabel icon={<Euro className="w-4 h-4" />} label="Ajustes Manuais" />

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Acréscimos (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— subsídio, prémio, etc.</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otherAdd}
              onChange={(e) => setOtherAdd(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Descontos (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— adiantamento, etc.</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otherDed}
              onChange={(e) => setOtherDed(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Notas</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Observações para este mês..."
              className={inputCls + " resize-none"}
            />
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: valor final a pagar */}
          <SectionLabel icon={<Euro className="w-4 h-4" />} label="Valor a pagar" />

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={overrideOn}
              onChange={(e) => {
                setOverrideOn(e.target.checked);
                // Ao ligar, parte-se do calculado — é o ponto de partida
                // honesto, e evita um campo vazio a dizer «0,00 €».
                if (e.target.checked && overrideValue === "") {
                  setOverrideValue(netCalculado.toFixed(2));
                }
              }}
              className="mt-0.5 w-4 h-4 accent-[var(--finance-primary)]"
            />
            <span className="text-sm text-[var(--color-text-main)]">
              Escrever o valor final à mão
              <span className="block text-xs text-[var(--color-text-muted)]">
                Sem isto, o líquido é sempre o resultado da conta acima.
              </span>
            </span>
          </label>

          {overrideOn && (
            <div className="space-y-3 pl-6">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                  Líquido a pagar (€)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={overrideValue}
                  onChange={(e) => setOverrideValue(e.target.value)}
                  className={inputCls}
                />
              </div>

              {overrideValido && diferenca !== 0 && (
                <p className="text-xs text-amber-700">
                  Difere do calculado ({fmtEur(netCalculado)}) em{" "}
                  {diferenca > 0 ? "+" : "−"}{fmtEur(Math.abs(diferenca))}.
                </p>
              )}

              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                  Porquê? <span className="text-red-600">*</span>
                </label>
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  rows={2}
                  placeholder="Ex.: acerto combinado com a colaboradora"
                  className={inputCls + " resize-none"}
                />
                {razaoEmFalta && (
                  <p className="mt-1 text-xs text-red-600">
                    Obrigatório. Fica registado na auditoria com o valor calculado ao lado.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Preview líquido */}
          <div className="p-4 rounded-xl bg-[var(--finance-primary-soft)] border border-[var(--color-primary-muted)]">
            <p className="text-xs text-[var(--color-text-muted)] mb-1">
              {overrideValido ? "Total líquido (escrito à mão)" : "Total líquido (pré-visualização)"}
            </p>
            <p className={`text-2xl font-bold ${previewNet >= 0 ? "text-[var(--finance-primary)]" : "text-red-600"}`}>
              {fmtEur(previewNet)}
            </p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
              {fmtEur(grossPreview)} bruto
              {baseSalaryVal > 0 ? " (base)" : ""}
              {" + "}{fmtEur(mealPreview)} alim.
              {" + "}{fmtEur(otBonusPreview)} extra
              {" + "}{fmtEur(addVal)} acrésc.
              {" − "}{fmtEur(absenceDedVal)} faltas
              {" − "}{fmtEur(dedVal)} desc.
              {overrideValido && diferenca !== 0 ? ` = ${fmtEur(netCalculado)} calculado` : ""}
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
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-semibold hover:bg-[var(--finance-primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Guardar
          </button>
        </div>
      </div>
    </>
  );
}
