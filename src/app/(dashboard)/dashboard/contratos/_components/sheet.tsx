"use client";

import { useState, useTransition, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, ChevronDown } from "lucide-react";
import { createContrato, updateContrato } from "@/app/actions/contratos";
import type { ScheduleDay } from "@/types/database";
import type { ContratosTableRow } from "../page";

// ─── Constantes ──────────────────────────────────────────────────────────────

const WEEKDAYS = [
  { value: 1, label: "Segunda" },
  { value: 2, label: "Terça" },
  { value: 3, label: "Quarta" },
  { value: 4, label: "Quinta" },
  { value: 5, label: "Sexta" },
  { value: 6, label: "Sábado" },
  { value: 0, label: "Domingo" },
];

const DAY_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

const FREQUENCY_OPTS = [
  { value: "weekly",   label: "Semanal — mesmos dias todas as semanas" },
  { value: "biweekly", label: "Quinzenal — mesmos dias, semana sim semana não" },
  { value: "daily",    label: "Diário — todos os dias úteis" },
  { value: "monthly",  label: "Mensal — uma vez por mês" },
  { value: "custom",   label: "Personalizado — a cada N dias" },
];

// ─── Preview de ocorrências ──────────────────────────────────────────────────

function calcOccurrences(
  frequency: string,
  weekdays: number[],
  startsOn: string,
  intervalDays: number,
  count = 12,
): Date[] {
  if (!startsOn) return [];
  const results: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(startsOn + "T00:00:00");
  const cursor = start >= today ? new Date(start) : new Date(today);

  let iter = 0;
  if (frequency === "daily") {
    while (results.length < count && iter < 400) {
      iter++;
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) results.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }

  if (frequency === "weekly" || frequency === "biweekly") {
    if (weekdays.length === 0) return [];
    // Para biweekly: calcular a semana de referência (paridade da semana ISO desde starts_on)
    const startWeek = Math.floor((start.getTime()) / (7 * 24 * 3600 * 1000));
    while (results.length < count && iter < 400) {
      iter++;
      const dow = cursor.getDay();
      const thisWeek = Math.floor((cursor.getTime()) / (7 * 24 * 3600 * 1000));
      const isCorrectWeek = frequency === "weekly" || (thisWeek - startWeek) % 2 === 0;
      if (isCorrectWeek && weekdays.includes(dow)) {
        results.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }

  if (frequency === "monthly") {
    const d = new Date(cursor);
    while (results.length < count && iter < 36) {
      iter++;
      results.push(new Date(d));
      d.setMonth(d.getMonth() + 1);
    }
    return results;
  }

  if (frequency === "custom") {
    const step = Math.max(1, intervalDays);
    while (results.length < count && iter < 400) {
      iter++;
      if (cursor >= start) results.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + step);
    }
    return results;
  }

  return results;
}

function OccurrencePreview({
  frequency, weekdays, startsOn, intervalDays,
}: { frequency: string; weekdays: number[]; startsOn: string; intervalDays: number }) {
  const dates = useMemo(
    () => calcOccurrences(frequency, weekdays, startsOn, intervalDays, 12),
    [frequency, weekdays, startsOn, intervalDays],
  );

  if (dates.length === 0) return null;

  const fmt = (d: Date) =>
    d.toLocaleDateString("pt-PT", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="mt-2 p-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
      <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">
        Próximas {dates.length} ocorrências:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {dates.map((d, i) => (
          <span
            key={i}
            className="text-xs px-2 py-1 rounded-md bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium"
          >
            {fmt(d)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Tipos de props ──────────────────────────────────────────────────────────

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  userId: string;
  clientes: { id: string; name: string }[];
  locais: { id: string; client_id: string; name: string; address: string; hourly_rate: number | null }[];
  equipas: { id: string; name: string; color: string }[];
  contrato?: ContratosTableRow;
}

// ─── Componente principal ────────────────────────────────────────────────────

export function ContratoSheet({ trigger, companyId, userId, clientes, locais, equipas, contrato }: Props) {
  const isEdit = !!contrato;

  // UI state
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // Formulário
  const [name, setName] = useState(contrato?.name ?? "");
  const [clienteId, setClienteId] = useState<string>(() => {
    if (contrato?.locations?.clients?.id) return contrato.locations.clients.id;
    return "";
  });
  const [localId, setLocalId] = useState(contrato?.locations?.id ?? "");
  const [frequency, setFrequency] = useState(contrato?.frequency ?? "weekly");
  const [intervalDays, setIntervalDays] = useState(1);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(contrato?.weekdays ?? [1, 3, 5]);
  const [startsOn, setStartsOn] = useState(contrato?.starts_on ?? new Date().toISOString().split("T")[0]);
  const [endsOn, setEndsOn] = useState(contrato?.ends_on ?? "");
  const [notes, setNotes] = useState(contrato?.notes ?? "");
  const [status, setStatus] = useState(contrato?.status ?? "ativo");

  // schedule_days: chave = day key (ex: "mon"), valor = config
  const initSchedule = (): Record<string, { start_time: string; duration_min: number; team_id: string }> => {
    if (contrato?.schedule_days?.length) {
      return Object.fromEntries(
        contrato.schedule_days.map((s) => [
          s.day,
          { start_time: s.start_time, duration_min: s.duration_min, team_id: s.team_id ?? "" },
        ]),
      );
    }
    return {};
  };
  const [scheduleConfig, setScheduleConfig] = useState<
    Record<string, { start_time: string; duration_min: number; team_id: string }>
  >(initSchedule);

  // Locais filtrados pelo cliente selecionado
  const locaisFiltrados = clienteId ? locais.filter((l) => l.client_id === clienteId) : locais;

  function toggleWeekday(d: number) {
    setSelectedWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  }

  function updateScheduleDay(dayKey: string, field: string, value: string | number) {
    setScheduleConfig((prev) => {
      const defaults = { start_time: "09:00", duration_min: 120, team_id: "" };
      return { ...prev, [dayKey]: { ...defaults, ...prev[dayKey], [field]: value } };
    });
  }

  // Quais dias precisam de config
  const daysToConfig = useMemo<Array<{ num: number; key: ScheduleDay["day"]; label: string }>>(() => {
    if (frequency === "weekly" || frequency === "biweekly") {
      return selectedWeekdays.map((d) => {
        const found = WEEKDAYS.find((w) => w.value === d)!;
        return { num: d, key: DAY_KEY[d], label: found?.label ?? String(d) };
      });
    }
    return [{ num: -1, key: "all" as ScheduleDay["day"], label: "Configuração padrão" }];
  }, [frequency, selectedWeekdays]);

  function buildScheduleDays(): ScheduleDay[] {
    return daysToConfig.map(({ key }) => {
      const cfg = scheduleConfig[key] ?? { start_time: "09:00", duration_min: 120, team_id: "" };
      return {
        day: key,
        start_time: cfg.start_time,
        duration_min: Number(cfg.duration_min),
        team_id: cfg.team_id || null,
      };
    });
  }

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);

    // Avisos não bloqueantes
    if (!localId) {
      setMessage({ type: "error", text: "Aviso: nenhum local selecionado." });
    }
    if ((frequency === "weekly" || frequency === "biweekly") && selectedWeekdays.length === 0) {
      setMessage({ type: "error", text: "Aviso: nenhum dia da semana selecionado." });
    }

    startTransition(async () => {
      const input = {
        location_id: localId,
        name: name || undefined,
        frequency,
        interval_days: frequency === "custom" ? intervalDays : 1,
        weekdays: (frequency === "weekly" || frequency === "biweekly") ? selectedWeekdays : null,
        schedule_days: buildScheduleDays(),
        starts_on: startsOn,
        ends_on: endsOn || undefined,
        status,
        notes: notes || undefined,
      };

      const res = isEdit
        ? await updateContrato(contrato.id, input)
        : await createContrato({ ...input, company_id: companyId, created_by: userId });

      if (res.ok) {
        setMessage({ type: "success", text: isEdit ? "Contrato atualizado." : "Contrato criado com sucesso." });
        if (!isEdit) {
          setName(""); setClienteId(""); setLocalId(""); setFrequency("weekly");
          setSelectedWeekdays([1, 3, 5]); setStartsOn(new Date().toISOString().split("T")[0]);
          setEndsOn(""); setNotes(""); setStatus("ativo"); setScheduleConfig({});
        }
      } else {
        setMessage({ type: "error", text: "Erro ao guardar: " + res.error });
      }
    });
  }

  const overlay = open ? createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        style={{ background: "rgba(9,14,26,0.45)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
        onClick={() => setOpen(false)}
      />
      <div
        className="fixed right-0 top-0 h-full w-full max-w-xl z-[9999] flex flex-col"
        style={{
          background: "rgba(255,255,255,0.97)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "-8px 0 40px rgba(9,14,26,0.14), -1px 0 0 rgba(15,23,42,0.07)",
        }}
      >
            {/* Header */}
            <div
              className="flex items-center justify-between px-6 py-4"
              style={{ borderBottom: "1px solid rgba(15,23,42,0.08)" }}
            >
              <h2 className="text-[15px] font-bold" style={{ color: "var(--color-text-main)", letterSpacing: "-0.01em" }}>
                {isEdit ? "Editar contrato" : "Novo contrato"}
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-xl transition-colors"
                style={{ color: "var(--color-text-muted)", background: "rgba(15,23,42,0.04)" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <form id="contrato-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {/* Nome (opcional) */}
              <Field label="Nome do contrato (opcional)">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex: Limpeza semanal Escritórios Central"
                  className={INPUT_CLS}
                />
              </Field>

              {/* Cliente → Local */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cliente *">
                  <div className="relative">
                    <select
                      value={clienteId}
                      onChange={(e) => { setClienteId(e.target.value); setLocalId(""); }}
                      className={SELECT_CLS}
                    >
                      <option value="">Selecionar...</option>
                      {clientes.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>
                <Field label="Local *">
                  <div className="relative">
                    <select
                      value={localId}
                      onChange={(e) => setLocalId(e.target.value)}
                      disabled={!clienteId}
                      className={SELECT_CLS + (clienteId ? "" : " opacity-50 cursor-not-allowed")}
                    >
                      <option value="">Selecionar...</option>
                      {locaisFiltrados.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>
              </div>

              {/* Frequência */}
              <Field label="Frequência *">
                <div className="relative">
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={SELECT_CLS}>
                    {FREQUENCY_OPTS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </Field>

              {/* Dias da semana (se weekly / biweekly) */}
              {(frequency === "weekly" || frequency === "biweekly") && (
                <Field label="Dias da semana *">
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((w) => (
                      <button
                        type="button"
                        key={w.value}
                        onClick={() => toggleWeekday(w.value)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                          selectedWeekdays.includes(w.value)
                            ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                            : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:border-[var(--color-primary)]"
                        }`}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {/* Intervalo (se custom) */}
              {frequency === "custom" && (
                <Field label="A cada quantos dias *">
                  <input
                    type="number"
                    min={1}
                    value={intervalDays}
                    onChange={(e) => setIntervalDays(Number(e.target.value))}
                    className={INPUT_CLS + " w-28"}
                  />
                </Field>
              )}

              {/* Config por dia */}
              <div>
                <p className="text-sm font-medium text-[var(--color-text-main)] mb-2">
                  {daysToConfig.length === 1 ? "Horário e equipa" : "Horário e equipa por dia"}
                </p>
                <div className="space-y-3">
                  {daysToConfig.map(({ key, label }) => {
                    const cfg = scheduleConfig[key] ?? { start_time: "09:00", duration_min: 120, team_id: "" };
                    return (
                      <div key={key} className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
                        {daysToConfig.length > 1 && (
                          <p className="text-xs font-semibold text-[var(--color-text-main)] mb-2">{label}</p>
                        )}
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Hora início</label>
                            <input
                              type="time"
                              value={cfg.start_time}
                              onChange={(e) => updateScheduleDay(key, "start_time", e.target.value)}
                              className={INPUT_CLS}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Duração (min)</label>
                            <input
                              type="number"
                              min={15}
                              step={15}
                              value={cfg.duration_min}
                              onChange={(e) => updateScheduleDay(key, "duration_min", Number(e.target.value))}
                              className={INPUT_CLS}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Equipa</label>
                            <div className="relative">
                              <select
                                value={cfg.team_id}
                                onChange={(e) => updateScheduleDay(key, "team_id", e.target.value)}
                                className={SELECT_CLS}
                              >
                                <option value="">Sem equipa</option>
                                {equipas.map((eq) => (
                                  <option key={eq.id} value={eq.id}>{eq.name}</option>
                                ))}
                              </select>
                              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Preview ocorrências */}
              <OccurrencePreview
                frequency={frequency}
                weekdays={selectedWeekdays}
                startsOn={startsOn}
                intervalDays={intervalDays}
              />

              {/* Vigência */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Data de início *">
                  <input
                    type="date"
                    required
                    value={startsOn}
                    onChange={(e) => setStartsOn(e.target.value)}
                    className={INPUT_CLS}
                  />
                </Field>
                <Field label="Data de fim (opcional)">
                  <input
                    type="date"
                    value={endsOn}
                    min={startsOn}
                    onChange={(e) => setEndsOn(e.target.value)}
                    className={INPUT_CLS}
                  />
                </Field>
              </div>

              {/* Estado (só edição) */}
              {isEdit && (
                <Field label="Estado">
                  <div className="relative">
                    <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT_CLS}>
                      <option value="ativo">Ativo</option>
                      <option value="pausado">Pausado</option>
                      <option value="cancelado">Cancelado</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>
              )}

              {/* Notas */}
              <Field label="Notas internas">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Instruções especiais, código de acesso, etc."
                  className={INPUT_CLS + " resize-none"}
                />
              </Field>

              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error"
                  ? "bg-red-50 text-red-700 border border-red-100"
                  : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
            </form>

            {/* Footer */}
            <div className="px-6 py-4" style={{ borderTop: "1px solid rgba(15,23,42,0.07)" }}>
              <button
                form="contrato-form"
                type="submit"
                disabled={pending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
                  color: "white",
                  boxShadow: "0 4px 12px rgba(34,197,94,0.28)",
                }}
              >
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar contrato"}
              </button>
            </div>
          </div>
    </>,
    document.body
  ) : null;

  return (
    <>
      <span onClick={() => setOpen(true)} style={{ display: "contents", cursor: "pointer" }}>
        {trigger}
      </span>
      {overlay}
    </>
  );
}

// ─── Helpers de estilo ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";
