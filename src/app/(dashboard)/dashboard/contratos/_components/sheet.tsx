"use client";

import { useEffect, useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { X, Loader2, Check, Users, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { createContrato, updateContrato } from "@/app/actions/contratos";
import type { ScheduleDay } from "@/types/database";
import type { ContratosTableRow } from "../page";
import {
  CLEANING_TYPES,
  PAYMENT_STATUSES,
  UPHOLSTERY_TYPES,
  showsPaymentStatus,
  isUpholstery,
} from "@/lib/cleaning-types";

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

// Config de um dia do horário. num_people só conta quando NÃO há equipa.
type CfgDay = { start_time: string; duration_min: number; team_id: string; num_people: number };
const DEFAULT_CFG: CfgDay = { start_time: "09:00", duration_min: 120, team_id: "", num_people: 1 };

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
  locais: {
    id: string;
    client_id: string;
    name: string;
    address: string;
    hourly_rate: number | null;
    access_code?: string | null;
    instructions?: string | null;
    has_key?: boolean | null;
    key_label?: string | null;
  }[];
  equipas: { id: string; name: string; color: string; member_count?: number }[];
  contrato?: ContratosTableRow;
  copyFrom?: ContratosTableRow;
  fixedClientId?: string;
  labels?: {
    createTitle?: string;
    editTitle?: string;
    createButton?: string;
    editButton?: string;
    nameLabel?: string;
    namePlaceholder?: string;
    createdMessage?: string;
    updatedMessage?: string;
  };
}

// ─── Componente principal ────────────────────────────────────────────────────

export function ContratoSheet({
  trigger,
  companyId,
  userId,
  clientes,
  locais,
  equipas,
  contrato,
  copyFrom,
  fixedClientId,
  labels,
}: Props) {
  const isEdit = !!contrato;
  const source = contrato ?? copyFrom;
  const createTitle = labels?.createTitle ?? "Novo contrato";
  const editTitle = labels?.editTitle ?? "Editar contrato";
  const createButton = labels?.createButton ?? "Criar contrato";
  const editButton = labels?.editButton ?? "Guardar alterações";

  const router = useRouter();

  // UI state
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // Formulário
  const [name, setName] = useState(source?.name ?? "");
  const [clienteId, setClienteId] = useState<string>(() => {
    if (fixedClientId) return fixedClientId;
    if (source?.locations?.clients?.id) return source.locations.clients.id;
    return "";
  });
  const [localId, setLocalId] = useState(source?.locations?.id ?? "");
  const [cleaningType, setCleaningType] = useState(source?.cleaning_type ?? "");
  const [frequency, setFrequency] = useState(source?.frequency ?? "weekly");
  const [intervalDays, setIntervalDays] = useState(source?.interval_days ?? 1);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(source?.weekdays ?? [1, 3, 5]);
  const [startsOn, setStartsOn] = useState(source?.starts_on ?? new Date().toISOString().split("T")[0]);
  const [endsOn, setEndsOn] = useState(source?.ends_on ?? "");
  const [notes, setNotes] = useState(source?.notes ?? "");
  const [status, setStatus] = useState(contrato?.status ?? "ativo");
  const [editScope, setEditScope] = useState("pattern");
  const [paymentStatus, setPaymentStatus] = useState(source?.payment_status ?? "nao_informado");
  const [upholsteryType, setUpholsteryType] = useState(source?.upholstery_type ?? "");
  const [upholsteryNotes, setUpholsteryNotes] = useState(source?.upholstery_notes ?? "");
  const [upholsteryUnits, setUpholsteryUnits] = useState(
    source?.upholstery_units != null ? String(source.upholstery_units) : "",
  );
  const [upholsteryUnitPrice, setUpholsteryUnitPrice] = useState(
    source?.upholstery_unit_price != null ? String(source.upholstery_unit_price) : "",
  );
  const [hourlyRate, setHourlyRate] = useState(
    source?.locations?.hourly_rate != null ? String(source.locations.hourly_rate) : "",
  );
  // Valor fixo por serviço: quando preenchido, ignora o cálculo por hora.
  const [fixedPrice, setFixedPrice] = useState(
    source?.fixed_price != null ? String(source.fixed_price) : "",
  );
  // schedule_days: chave = day key (ex: "mon"), valor = config.
  // num_people só é usado quando NÃO há equipa (preenchido à mão).
  const initSchedule = (): Record<string, CfgDay> => {
    if (source?.schedule_days?.length) {
      return Object.fromEntries(
        source.schedule_days.map((s) => [
          s.day,
          {
            start_time: s.start_time,
            duration_min: s.duration_min,
            team_id: s.team_id ?? "",
            num_people: s.num_people != null && s.num_people >= 1 ? s.num_people : 1,
          },
        ]),
      );
    }
    return {};
  };
  const [scheduleConfig, setScheduleConfig] = useState<Record<string, CfgDay>>(initSchedule);

  // Locais filtrados pelo cliente selecionado
  const locaisFiltrados = clienteId ? locais.filter((l) => l.client_id === clienteId) : locais;
  const selectedLocal = locais.find((l) => l.id === localId) ?? null;

  // Visibilidade condicional
  const showPayment = showsPaymentStatus(cleaningType);
  const showUpholstery = isUpholstery(cleaningType);
  // Quantidade × preço unitário disponível para qualquer tipo de estofado selecionado.
  const showUnits = showUpholstery && upholsteryType !== "";

  // Estofos por unidade: quantidade × preço unitário
  const upholsteryTotal = showUnits
    ? Number(upholsteryUnits || 0) * Number((upholsteryUnitPrice || "0").replace(",", "."))
    : null;

  useEffect(() => {
    if (!selectedLocal || isEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHourlyRate(selectedLocal.hourly_rate != null ? String(selectedLocal.hourly_rate) : "");
  }, [isEdit, selectedLocal]);

  // Escape fecha o modal
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) setOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, pending]);

  function toggleWeekday(d: number) {
    setSelectedWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  }

  function updateScheduleDay(dayKey: string, field: string, value: string | number) {
    setScheduleConfig((prev) => ({
      ...prev,
      [dayKey]: { ...DEFAULT_CFG, ...prev[dayKey], [field]: value },
    }));
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

  const parsedHourlyRate = hourlyRate.trim() === "" ? null : Number(hourlyRate.replace(",", "."));
  const parsedFixedPrice = fixedPrice.trim() === "" ? null : Number(fixedPrice.replace(",", "."));
  const useFixedPrice = parsedFixedPrice != null && Number.isFinite(parsedFixedPrice) && parsedFixedPrice > 0;

  // Tamanho da equipa atribuída (membros ativos). 0 → 1 para o cálculo.
  const teamSize = (teamId: string) => {
    const eq = equipas.find((e) => e.id === teamId);
    return eq?.member_count && eq.member_count > 0 ? eq.member_count : 1;
  };
  // Nº de pessoas efetivo de um dia: com equipa = tamanho da equipa;
  // sem equipa = quantidade preenchida à mão.
  const peopleForDay = (cfg: CfgDay) =>
    cfg.team_id ? teamSize(cfg.team_id) : Math.max(1, Math.floor(cfg.num_people || 1));

  const totalDurationMin = useMemo(
    () => daysToConfig.reduce((sum, { key }) => {
      const cfg = scheduleConfig[key] ?? DEFAULT_CFG;
      return sum + Number(cfg.duration_min || 0);
    }, 0),
    [daysToConfig, scheduleConfig],
  );

  // Valor = Σ por dia de (horas × valor/hora × nº de pessoas desse dia).
  // Cada colaboradora conta como uma hora: 12€/h com 3 pessoas = 36€/h.
  const calculatedValue = useFixedPrice
    ? parsedFixedPrice
    : parsedHourlyRate != null && Number.isFinite(parsedHourlyRate)
    ? daysToConfig.reduce((sum, { key }) => {
        const cfg = scheduleConfig[key] ?? DEFAULT_CFG;
        return sum + (Number(cfg.duration_min || 0) / 60) * parsedHourlyRate * peopleForDay(cfg);
      }, 0)
    : null;
  // Nº de pessoas representativo para o resumo (1.º dia configurado).
  const summaryPeople = daysToConfig.length > 0
    ? peopleForDay(scheduleConfig[daysToConfig[0].key] ?? DEFAULT_CFG)
    : 1;

  function buildScheduleDays(): ScheduleDay[] {
    return daysToConfig.map(({ key }) => {
      const cfg = scheduleConfig[key] ?? DEFAULT_CFG;
      return {
        day: key,
        start_time: cfg.start_time,
        duration_min: Number(cfg.duration_min),
        team_id: cfg.team_id || null,
        // Sem equipa → guarda o nº de pessoas preenchido; com equipa → null.
        num_people: cfg.team_id ? null : Math.max(1, Math.floor(cfg.num_people || 1)),
      };
    });
  }

  function resetForm() {
    setName(""); setClienteId(fixedClientId ?? ""); setLocalId(""); setCleaningType("");
    setFrequency("weekly"); setSelectedWeekdays([1, 3, 5]);
    setStartsOn(new Date().toISOString().split("T")[0]);
    setEndsOn(""); setNotes(""); setStatus("ativo"); setScheduleConfig({});
    setPaymentStatus("nao_informado"); setUpholsteryType(""); setUpholsteryNotes("");
    setUpholsteryUnits(""); setUpholsteryUnitPrice("");
    setStep(1);
  }

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    setSaved(false);

    // Avisos não bloqueantes
    if (!localId) {
      setMessage({ type: "error", text: "Aviso: nenhum local selecionado." });
    }
    if ((frequency === "weekly" || frequency === "biweekly") && selectedWeekdays.length === 0) {
      setMessage({ type: "error", text: "Aviso: nenhum dia da semana selecionado." });
    }
    if (parsedHourlyRate != null && (!Number.isFinite(parsedHourlyRate) || parsedHourlyRate < 0)) {
      setMessage({ type: "error", text: "Valor por hora inválido." });
      return;
    }
    if (showUpholstery && !upholsteryType) {
      setMessage({ type: "error", text: "Seleciona o tipo de estofado." });
      return;
    }
    if (showUnits && (upholsteryUnits === "" || Number(upholsteryUnits) <= 0)) {
      setMessage({ type: "error", text: "Indica o número de unidades do estofado." });
      return;
    }

    startTransition(async () => {
      const input = {
        location_id: localId,
        name: name || undefined,
        hourly_rate: parsedHourlyRate,
        // Nº de pessoas agora é por dia (em schedule_days). Mantém o campo do
        // contrato a null para retrocompatibilidade.
        num_people: null,
        frequency,
        interval_days: frequency === "custom" ? intervalDays : 1,
        weekdays: (frequency === "weekly" || frequency === "biweekly") ? selectedWeekdays : null,
        schedule_days: buildScheduleDays(),
        starts_on: startsOn,
        ends_on: endsOn || undefined,
        status,
        notes: notes || undefined,
        cleaning_type: cleaningType || null,
        payment_status: showPayment ? paymentStatus : null,
        upholstery_type: showUpholstery ? (upholsteryType || null) : null,
        upholstery_notes: showUpholstery ? (upholsteryNotes || null) : null,
        upholstery_units: showUnits && upholsteryUnits !== "" ? Number(upholsteryUnits) : null,
        upholstery_unit_price: showUnits && upholsteryUnitPrice !== ""
          ? Number(upholsteryUnitPrice.replace(",", ".")) : null,
        // Estofos por unidade: o total (qtd × preço) passa a ser o valor por ocorrência
        unit_value: upholsteryTotal != null && upholsteryTotal > 0 ? upholsteryTotal : null,
        // Valor fixo por serviço: tem prioridade sobre o cálculo por hora.
        fixed_price: useFixedPrice ? parsedFixedPrice : null,
      };

      const res = isEdit
        ? await updateContrato(contrato.id, input)
        : await createContrato({ ...input, company_id: companyId, created_by: userId });

      if (res.ok) {
        // Não fecha automaticamente: mostra "Guardado" no botão e o utilizador
        // fecha no X quando quiser (confirma visualmente que guardou).
        setSaved(true);
        setMessage({
          type: "success",
          text: isEdit
            ? labels?.updatedMessage ?? "Contrato atualizado."
            : labels?.createdMessage ?? "Contrato criado com sucesso.",
        });
        router.refresh();
      } else {
        setMessage({ type: "error", text: "Erro ao guardar: " + res.error });
      }
    });
  }

  const overlay = open ? createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Fundo: NÃO fecha ao clicar (evita perder a edição por clique acidental).
          Fecha só pelo X, Cancelar ou ao guardar. */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">
              {isEdit ? editTitle : createTitle}
            </h2>
            <StepIndicator step={step} />
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form id="contrato-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* ── ETAPA 1 — Dados principais ── */}
          {step === 1 && (
            <>
              <SectionLabel title="Dados principais" />

              {/* Nome (opcional) */}
              <Field label={labels?.nameLabel ?? "Nome do contrato (opcional)"}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={labels?.namePlaceholder ?? "ex: Limpeza semanal Escritórios Central"}
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
                      disabled={!!fixedClientId}
                      className={SELECT_CLS + (fixedClientId ? " opacity-70 cursor-not-allowed" : "")}
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

              {/* Tipo de limpeza */}
              <Field label="Tipo de limpeza">
                <div className="relative">
                  <select value={cleaningType} onChange={(e) => setCleaningType(e.target.value)} className={SELECT_CLS}>
                    <option value="">Selecionar...</option>
                    {CLEANING_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </Field>

              {/* Estado do pagamento — Geral / Pós-Obra */}
              {showPayment && (
                <Field label="Estado do pagamento">
                  <div className="relative">
                    <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className={SELECT_CLS}>
                      {PAYMENT_STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Lembrete de sinal 50% ou pagamento total.
                  </p>
                </Field>
              )}

              {/* Estofos — tipo + especificação (+ unidades) */}
              {showUpholstery && (
                <div className="space-y-3 rounded-lg border border-[var(--color-primary-muted)] bg-[var(--color-primary-light)] p-3">
                  <Field label="Tipo de estofado">
                    <div className="relative">
                      <select value={upholsteryType} onChange={(e) => setUpholsteryType(e.target.value)} className={SELECT_CLS}>
                        <option value="">Selecionar...</option>
                        {UPHOLSTERY_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                    </div>
                  </Field>

                  {showUnits && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Nº de unidades">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={upholsteryUnits}
                          onChange={(e) => setUpholsteryUnits(e.target.value)}
                          placeholder="ex: 3"
                          className={INPUT_CLS}
                        />
                      </Field>
                      <Field label="Preço por unidade (€)">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={upholsteryUnitPrice}
                          onChange={(e) => setUpholsteryUnitPrice(e.target.value)}
                          placeholder="ex: 25.00"
                          className={INPUT_CLS}
                        />
                      </Field>
                      <div className="col-span-2 rounded-lg border border-[var(--color-primary-muted)] bg-white px-3 py-2 text-sm font-semibold text-[var(--color-text-main)]">
                        Total: {upholsteryTotal == null || upholsteryTotal <= 0
                          ? "—"
                          : `${upholsteryTotal.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
                      </div>
                    </div>
                  )}

                  <Field label="Especificação do estofado">
                    <textarea
                      value={upholsteryNotes}
                      onChange={(e) => setUpholsteryNotes(e.target.value)}
                      rows={3}
                      placeholder="Tamanho, quantidade, tipo de tecido, manchas, etc."
                      className={INPUT_CLS + " resize-none"}
                    />
                  </Field>
                </div>
              )}

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

              {/* Vigência */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Data de início *">
                  <input
                    type="date"
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

              {/* Preview ocorrências */}
              <OccurrencePreview
                frequency={frequency}
                weekdays={selectedWeekdays}
                startsOn={startsOn}
                intervalDays={intervalDays}
              />

              {/* Valor por hora */}
              <Field label="Valor por hora (€)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                  placeholder="ex: 18.50"
                  disabled={useFixedPrice}
                  className={INPUT_CLS}
                />
              </Field>

              {/* Valor fixo por serviço (alternativa ao valor/hora) */}
              <Field label="Valor fixo por serviço (€)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={fixedPrice}
                  onChange={(e) => setFixedPrice(e.target.value)}
                  placeholder="ex: 50.00 (deixa vazio para faturar por hora)"
                  className={INPUT_CLS}
                />
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Se preencheres, cada serviço deste contrato vale este valor fixo (ignora o valor/hora).
                </p>
              </Field>

              {/* Estado do contrato */}
              <Field label="Estado do contrato">
                <div className="relative">
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT_CLS}>
                    <option value="ativo">Ativo</option>
                    <option value="pausado">Pausado</option>
                    <option value="cancelado">Cancelado</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </Field>
            </>
          )}

          {/* ── ETAPA 2 — Detalhes ── */}
          {step === 2 && (
            <>
              {isEdit && (
                <Field label="Edição segura da recorrência">
                  <div className="grid gap-2 text-xs text-[var(--color-text-sub)]">
                    {[
                      ["single", "Alterar apenas esta ocorrência"],
                      ["future", "Alterar esta e as próximas"],
                      ["pattern", "Alterar o padrão recorrente"],
                      ["exception", "Criar exceção só para este dia"],
                    ].map(([value, label]) => (
                      <label key={value} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                        <input
                          type="radio"
                          name="editScope"
                          value={value}
                          checked={editScope === value}
                          onChange={(e) => setEditScope(e.target.value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    Esta tela atualiza o contrato. Ocorrências já concluídas, em curso, falta ou canceladas não são reescritas aqui.
                  </p>
                </Field>
              )}

              <SectionLabel title="Equipa e horários" />

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
                            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Duração (h)</label>
                            <input
                              type="number"
                              min={0.25}
                              step={0.25}
                              value={Number((cfg.duration_min / 60).toFixed(2))}
                              onChange={(e) => updateScheduleDay(key, "duration_min", Math.round(Number(e.target.value) * 60))}
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
                        {cfg.team_id ? (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                            <Users className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                            {teamSize(cfg.team_id)} colaboradora(s) na equipa · usado no cálculo do valor
                          </p>
                        ) : (
                          <div className="mt-2">
                            <label className="block text-xs text-[var(--color-text-muted)] mb-1 flex items-center gap-1.5">
                              <Users className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                              Nº de colaboradoras (sem equipa)
                            </label>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={cfg.num_people}
                              onChange={(e) => updateScheduleDay(key, "num_people", Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                              className={INPUT_CLS + " max-w-[8rem]"}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Valor calculado */}
              <Field label="Valor calculado">
                {(() => {
                  const useUnits = upholsteryTotal != null && upholsteryTotal > 0;
                  const shown = useFixedPrice ? parsedFixedPrice : useUnits ? upholsteryTotal : calculatedValue;
                  return (
                    <>
                      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm font-semibold text-[var(--color-text-main)]">
                        {shown == null
                          ? "—"
                          : `${shown.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                        {useFixedPrice
                          ? "valor fixo por serviço"
                          : useUnits
                          ? `${upholsteryUnits || 0} unidade(s) x preço unitário`
                          : `${(totalDurationMin / 60).toLocaleString("pt-PT", { maximumFractionDigits: 2 })}h x valor/hora x ${summaryPeople} pessoa(s)`}
                      </p>
                    </>
                  );
                })()}
              </Field>

              {/* Observações internas */}
              <Field label="Observações internas">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Instruções do serviço, materiais necessários, etc."
                  className={INPUT_CLS + " resize-none"}
                />
              </Field>

              {/* Acesso do local (instruções fixas) */}
              <SectionLabel title="Instruções do serviço / acesso do local" />
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 text-xs text-[var(--color-text-sub)]">
                {!selectedLocal ? (
                  <p>Seleciona um local para ver instruções fixas de acesso.</p>
                ) : (
                  <div className="space-y-1">
                    <p><strong>Morada:</strong> {selectedLocal.address}</p>
                    <p><strong>Chave:</strong> {selectedLocal.has_key ? selectedLocal.key_label || "Registada" : "Não registada"}</p>
                    <p><strong>Código:</strong> {selectedLocal.access_code ? "Registado" : "Não registado"}</p>
                    {selectedLocal.instructions && <p><strong>Instruções:</strong> {selectedLocal.instructions}</p>}
                  </div>
                )}
              </div>
            </>
          )}

          {message && (
            <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error"
              ? "bg-red-50 text-red-700 border border-red-100"
              : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
              {message.text}
            </div>
          )}
        </form>

        {/* Footer — navegação */}
        <div className="flex items-center gap-2 px-6 py-4 border-t border-[var(--color-border)]">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!clienteId || !localId) {
                    setMessage({ type: "error", text: "Seleciona o cliente e o local antes de continuar." });
                    return;
                  }
                  setMessage(null);
                  setStep(2);
                }}
                className="ml-auto flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
              >
                Seguinte
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Voltar
              </button>
              <button
                form="contrato-form"
                type="submit"
                disabled={pending}
                className="ml-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                style={{
                  background: saved
                    ? "linear-gradient(135deg, #16A34A 0%, #15803D 100%)"
                    : "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
                  color: "white",
                  boxShadow: "0 4px 12px rgba(34,197,94,0.28)",
                }}
              >
                {pending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    A guardar...
                  </>
                ) : saved ? (
                  <>
                    <Check className="w-4 h-4" />
                    Guardado
                  </>
                ) : (
                  isEdit ? editButton : createButton
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <span
        onClick={() => {
          // Form novo (não edição, não duplicação) começa limpo a cada abertura.
          if (!isEdit && !copyFrom) resetForm();
          setStep(1); setSaved(false); setMessage(null); setOpen(true);
        }}
        style={{ display: "contents", cursor: "pointer" }}
      >
        {trigger}
      </span>
      {overlay}
    </>
  );
}

// ─── Helpers de estilo ────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className={`text-xs font-medium ${step === 1 ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
        1. Dados principais
      </span>
      <span className="text-[var(--color-text-muted)]">›</span>
      <span className={`text-xs font-medium ${step === 2 ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
        2. Detalhes
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="border-b border-[var(--color-border)] pb-2">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</p>
    </div>
  );
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";
