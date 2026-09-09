"use client";

import { useState } from "react";
import { X, Loader2, AlertCircle, Clock, Euro, Percent } from "lucide-react";
import { adjustPayrollRecord, type PayrollRecord } from "@/app/actions/payroll";

interface Props {
  record: PayrollRecord;
  onClose: () => void;
  onSaved: (updated: PayrollRecord) => void;
}

/** Horas em português: "168h", "7,5h". */
function fmtH(v: number) {
  return `${v.toLocaleString("pt-PT", { maximumFractionDigits: 2 })}h`;
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

/**
 * Um campo numérico a zero mostra-se VAZIO, não "0".
 *
 * 🔴 Com "0" lá dentro, escrever 80 dá "080": o cursor fica depois do zero e
 *    o valor antigo não é substituído. Foi reportado como «coloco o valor e
 *    ainda fica o 0». O placeholder diz o que acontece se ficar vazio, sem
 *    obrigar a apagar um carácter antes de cada edição.
 */
function campoNumerico(v: number): string {
  return v === 0 ? "" : String(v);
}

export function PayrollEditSheet({ record, onClose, onSaved }: Props) {
  // Campos de taxas
  const [hourlyRate,    setHourlyRate]    = useState(campoNumerico(record.hourly_rate));
  const mealPerDayInit = record.days_worked > 0 ? record.meal_allowance / record.days_worked : 9.6;
  const [mealDay,       setMealDay]       = useState(mealPerDayInit === 0 ? "" : mealPerDayInit.toFixed(2));
  // Campos de horas
  const [workedHours,   setWorkedHours]   = useState(campoNumerico(record.worked_hours));
  const [overtimeHours, setOvertimeHours] = useState(campoNumerico(record.overtime_hours));
  const [absenceHours,  setAbsenceHours]  = useState(campoNumerico(record.absence_hours));
  const [daysWorked,    setDaysWorked]    = useState(campoNumerico(record.days_worked));
  // Desconto por falta (€)
  const [absenceDed,    setAbsenceDed]    = useState(campoNumerico(record.absence_deductions));
  // Vencimento base do mês
  const [baseSalary, setBaseSalary] = useState(campoNumerico(record.base_salary));
  // Hora extra ao valor, dias extras e adiantamento
  const [otHourRate,  setOtHourRate]  = useState(
    record.overtime_hour_rate !== null ? String(record.overtime_hour_rate) : "",
  );
  const [extraDays,    setExtraDays]    = useState(campoNumerico(record.extra_days));
  const [extraDayRate, setExtraDayRate] = useState(campoNumerico(record.extra_day_rate));
  const [advance,      setAdvance]      = useState(campoNumerico(record.advance_deduction));
  // Líquido escrito à mão
  const [overrideOn,     setOverrideOn]     = useState(record.net_salary_override !== null);
  const [overrideValue,  setOverrideValue]  = useState(
    record.net_salary_override !== null ? record.net_salary_override.toString() : "",
  );
  const [overrideReason, setOverrideReason] = useState(record.net_salary_override_reason ?? "");
  // Ajustes manuais
  const [otherAdd, setOtherAdd] = useState(campoNumerico(record.other_additions));
  const [otherDed, setOtherDed] = useState(campoNumerico(record.other_deductions));
  const [notes,    setNotes]    = useState(record.notes ?? "");

  // As horas foram corrigidas à mão? Começa como está gravado, e passa a true
  // assim que algum dos três campos de horas se afasta do que o ponto diz.
  const [horasManuais, setHorasManuais] = useState(record.hours_manual);

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
  // Ligar o campo e deixá-lo vazio não pode ser ignorado em silêncio: quem o
  // ligou está à espera de pagar outro valor, e sair daqui com o calculado
  // seria a interface a decidir por si.
  const overrideVazio    = overrideOn && !Number.isFinite(overrideVal);

  // Com vencimento base, o bruto É o base. Mesma regra do servidor.
  const grossPreview    = baseSalaryVal > 0
    ? baseSalaryVal
    : Math.round(workedHoursVal * hourlyRateVal * 100) / 100;
  const mealPreview     = Math.round(daysWorkedVal * mealDayVal * 100) / 100;
  const otHourRateVal   = parseFloat(otHourRate);
  const temValorHoraExtra = Number.isFinite(otHourRateVal) && otHourRateVal > 0;
  // Com €/hora extra, a percentagem sai da conta. Sem ele, mantém-se como era.
  const otBonusPreview  = temValorHoraExtra
    ? Math.round(overtimeHoursVal * otHourRateVal * 100) / 100
    : Math.round(overtimeHoursVal * hourlyRateVal * ((record.overtime_rate_pct ?? 25) / 100) * 100) / 100;

  const extraDaysVal     = parseInt(extraDays) || 0;
  const extraDayRateVal  = parseFloat(extraDayRate) || 0;
  const extraDaysPreview = extraDaysVal > 0 && extraDayRateVal > 0
    ? Math.round(extraDaysVal * extraDayRateVal * 100) / 100
    : 0;
  const advanceVal       = parseFloat(advance) || 0;

  // O que o ponto diz, quando já houve um recálculo com ponto.
  const temPonto = record.clock_worked_hours !== null
    || record.clock_days_worked !== null
    || record.clock_absence_hours !== null;

  const difereDoPonto =
    (record.clock_worked_hours  !== null && workedHoursVal !== record.clock_worked_hours)
    || (record.clock_days_worked   !== null && daysWorkedVal  !== record.clock_days_worked)
    || (record.clock_absence_hours !== null && (parseFloat(absenceHours) || 0) !== record.clock_absence_hours);

  const emUsoManual = horasManuais || difereDoPonto;

  /** Devolve as horas às do ponto, e desmarca a correcção manual. */
  function reporDoPonto() {
    if (record.clock_worked_hours  !== null) setWorkedHours(campoNumerico(record.clock_worked_hours));
    if (record.clock_days_worked   !== null) setDaysWorked(campoNumerico(record.clock_days_worked));
    if (record.clock_absence_hours !== null) setAbsenceHours(campoNumerico(record.clock_absence_hours));
    setHorasManuais(false);
  }
  const netCalculado    = Math.round(
    (grossPreview + mealPreview + otBonusPreview + extraDaysPreview + addVal
      - absenceDedVal - advanceVal - dedVal) * 100,
  ) / 100;
  // O que se vai pagar: o escrito à mão, ou a conta.
  const previewNet      = overrideValido ? overrideVal : netCalculado;
  const diferenca       = Math.round((previewNet - netCalculado) * 100) / 100;
  const razaoEmFalta    = overrideValido && overrideReason.trim().length < 3;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (overrideVazio) {
      setError("Escreva o valor líquido a pagar, ou desligue a opção.");
      setSaving(false);
      return;
    }
    if (razaoEmFalta) {
      setError("Escreva porque é que o líquido difere do calculado.");
      setSaving(false);
      return;
    }

    const res = await adjustPayrollRecord(record.id, {
      base_salary:         baseSalaryVal,
      // Só se manda quando é uma decisão: repor (false) ou corrigir (true).
      // Ausente deixa a RPC decidir pela comparação com o ponto.
      hours_manual:        emUsoManual ? true : (temPonto ? false : undefined),
      overtime_hour_rate:  temValorHoraExtra ? otHourRateVal : null,
      extra_days:          extraDaysVal,
      extra_day_rate:      extraDayRateVal,
      advance_deduction:   advanceVal,
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
        hours_manual:        emUsoManual,
        overtime_hour_rate:  temValorHoraExtra ? otHourRateVal : null,
        extra_days:          extraDaysVal,
        extra_day_rate:      extraDayRateVal,
        extra_days_bonus:    extraDaysPreview,
        advance_deduction:   advanceVal,
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
              placeholder="0,00"
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
              placeholder="0,00"
                onChange={(e) => setMealDay(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: Correções de Horas */}
          <SectionLabel icon={<Clock className="w-4 h-4" />} label="Horas" />

          <div className={`p-3 rounded-lg border text-xs ${
            emUsoManual
              ? "bg-amber-50 border-amber-200 text-amber-900"
              : "bg-[var(--color-background)] border-[var(--color-border)] text-[var(--color-text-sub)]"
          }`}>
            {temPonto ? (
              <>
                <p className="font-medium">
                  {emUsoManual ? "Horas corrigidas à mão" : "Horas vindas do ponto"}
                </p>
                <p className="mt-0.5">
                  O ponto diz: <strong>{fmtH(record.clock_worked_hours ?? 0)}</strong>
                  {" · "}<strong>{record.clock_days_worked ?? 0}</strong> dia
                  {(record.clock_days_worked ?? 0) !== 1 ? "s" : ""}
                  {(record.clock_absence_hours ?? 0) > 0
                    ? ` · ${fmtH(record.clock_absence_hours ?? 0)} de falta`
                    : ""}
                </p>
                {emUsoManual && (
                  <>
                    <p className="mt-1">
                      Enquanto estiver assim, <strong>recalcular a folha não mexe nestes valores</strong>.
                    </p>
                    <button
                      type="button"
                      onClick={reporDoPonto}
                      className="mt-2 px-2.5 py-1 rounded-md border border-amber-300 bg-white text-amber-900 font-medium hover:bg-amber-100 transition-colors"
                    >
                      Repor do ponto
                    </button>
                  </>
                )}
              </>
            ) : (
              <p>
                Ainda não há registo de ponto para este mês. Escreve as horas à mão —
                quando o ponto começar a ser usado, aparece aqui e podes voltar a ele.
              </p>
            )}
          </div>

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
              placeholder="0,00"
              onChange={(e) => setAbsenceDed(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Secção: Dias extras e hora extra ao valor */}
          <SectionLabel icon={<Euro className="w-4 h-4" />} label="Dias extras e hora extra" />

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Valor por hora extra (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— deixa vazio para usar a percentagem</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otHourRate}
              onChange={(e) => setOtHourRate(e.target.value)}
              className={inputCls}
              placeholder={`${record.overtime_rate_pct ?? 25}% da hora normal`}
            />
            {overtimeHoursVal > 0 && (
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                {overtimeHoursVal}h × {temValorHoraExtra ? fmtEur(otHourRateVal) : `${record.overtime_rate_pct ?? 25}%`}
                {" = "}{fmtEur(otBonusPreview)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Dias extras
                <span className="text-[var(--color-text-muted)] font-normal ml-1">— sábados, etc.</span>
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={extraDays}
                onChange={(e) => setExtraDays(e.target.value)}
                className={inputCls}
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
                Valor por dia extra (€)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={extraDayRate}
                onChange={(e) => setExtraDayRate(e.target.value)}
                className={inputCls}
                placeholder="0,00"
              />
            </div>
          </div>

          {extraDaysPreview > 0 && (
            <p className="-mt-1 text-xs text-[var(--finance-primary)]">
              {extraDaysVal} dia{extraDaysVal !== 1 ? "s" : ""} × {fmtEur(extraDayRateVal)} = <strong>{fmtEur(extraDaysPreview)}</strong>
            </p>
          )}

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
              placeholder="0,00"
              onChange={(e) => setOtherAdd(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Adiantamento a descontar (€)
              <span className="text-[var(--color-text-muted)] font-normal ml-1">— dinheiro já entregue</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={advance}
              onChange={(e) => setAdvance(e.target.value)}
              className={inputCls}
              placeholder="0,00"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Outros descontos (€)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={otherDed}
              placeholder="0,00"
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

              {overrideVazio && (
                <p className="text-xs text-red-600">
                  Escreva o valor a pagar, ou desligue a opção acima.
                </p>
              )}

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
              {" + "}{fmtEur(otBonusPreview)} h.extra
              {extraDaysPreview > 0 ? ` + ${fmtEur(extraDaysPreview)} dias extra` : ""}
              {" + "}{fmtEur(addVal)} acrésc.
              {" − "}{fmtEur(absenceDedVal)} faltas
              {advanceVal > 0 ? ` − ${fmtEur(advanceVal)} adiant.` : ""}
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
            disabled={saving || razaoEmFalta || overrideVazio}
            title={
              overrideVazio ? "Escreva o valor líquido a pagar, ou desligue a opção."
              : razaoEmFalta ? "Escreva porque é que o líquido difere do calculado."
              : undefined
            }
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-semibold hover:bg-[var(--finance-primary-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Guardar
          </button>
        </div>
      </div>
    </>
  );
}
