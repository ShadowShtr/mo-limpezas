"use client";

import { useState, useTransition } from "react";
import { Save, CheckCircle2, AlertCircle } from "lucide-react";
import { saveCompanySettings, type CompanySettings } from "@/app/actions/settings";

interface Props {
  initial: CompanySettings;
}

export function SettingsForm({ initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [values, setValues] = useState<CompanySettings>(initial);

  function set<K extends keyof CompanySettings>(key: K, raw: string) {
    setValues((prev) => ({
      ...prev,
      [key]: typeof initial[key] === "number" ? (raw === "" ? 0 : parseFloat(raw)) : raw,
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await saveCompanySettings(values);
      setMsg(res.ok ? { ok: true, text: "Configurações guardadas com sucesso." } : { ok: false, text: res.error });
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* ── FATURAÇÃO ── */}
      <Section title="Faturação" description="Valores usados na geração de extratos e faturas.">
        <Field label="IVA (%)" hint="Percentagem de IVA aplicada nos extratos e faturas.">
          <NumberInput
            value={values.vat_rate}
            onChange={(v) => set("vat_rate", v)}
            step="0.01"
            min="0"
            max="100"
            suffix="%"
          />
        </Field>
        <Field label="Prefixo das faturas" hint="Prefixo do número de fatura, ex: 'F' gera F2024/001.">
          <input
            type="text"
            value={values.invoice_prefix}
            onChange={(e) => set("invoice_prefix", e.target.value)}
            maxLength={5}
            className={inputCls}
          />
        </Field>
      </Section>

      {/* ── SALÁRIOS ── */}
      <Section title="Salários" description="Base de cálculo para folhas de pagamento.">
        <Field label="Valor hora global (€)" hint="Custo por hora padrão para colaboradores sem valor individual definido.">
          <NumberInput
            value={values.hourly_rate}
            onChange={(v) => set("hourly_rate", v)}
            step="0.01"
            min="0"
            suffix="€/h"
          />
        </Field>
        <Field label="Subsídio de alimentação (€/dia)" hint="Valor diário de subsídio de alimentação pago como transferência no salário.">
          <NumberInput
            value={values.meal_allowance_day}
            onChange={(v) => set("meal_allowance_day", v)}
            step="0.01"
            min="0"
            suffix="€/dia"
          />
        </Field>
        <Field label="Acréscimo hora extra (%)" hint="Percentagem de acréscimo aplicada sobre o valor hora em horas extraordinárias.">
          <NumberInput
            value={values.overtime_rate_pct}
            onChange={(v) => set("overtime_rate_pct", v)}
            step="0.01"
            min="0"
            max="200"
            suffix="%"
          />
        </Field>
      </Section>

      {/* ── COLABORADORES ── */}
      <Section title="Colaboradores" description="Valores padrão aplicados a novos colaboradores.">
        <Field label="Dias de férias por ano" hint="Número padrão de dias de férias anuais (mínimo legal PT: 22 dias).">
          <NumberInput
            value={values.vacation_days_year}
            onChange={(v) => set("vacation_days_year", v)}
            step="1"
            min="22"
            suffix="dias"
          />
        </Field>
      </Section>

      {/* ── OPERACIONAL ── */}
      <Section title="Operacional" description="Configurações de funcionamento da plataforma.">
        <Field label="Raio GPS de validação (metros)" hint="Distância máxima ao local para validar clock-in/out sem aviso. Abaixo deste raio é considerado no local.">
          <NumberInput
            value={values.gps_radius_meters}
            onChange={(v) => set("gps_radius_meters", v)}
            step="10"
            min="50"
            suffix="m"
          />
        </Field>
        <Field label="Fuso horário" hint="Fuso horário usado para datas e relatórios.">
          <select
            value={values.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            className={inputCls}
          >
            <option value="Europe/Lisbon">Europa/Lisboa (GMT+0/+1)</option>
            <option value="Europe/London">Europa/Londres (GMT+0/+1)</option>
            <option value="Atlantic/Azores">Atlântico/Açores (GMT-1/0)</option>
            <option value="America/Sao_Paulo">América/São Paulo (GMT-3)</option>
          </select>
        </Field>
      </Section>

      {/* ── PONTO ELECTRÓNICO ── */}
      <Section title="Ponto Electrónico" description="Janela de tempo permitida para os colaboradores iniciarem e encerrarem o ponto.">
        <Field
          label="Minutos antes para iniciar"
          hint="Quantos minutos antes do horário previsto do serviço o colaborador pode fazer clock-in. Ex: 40 significa que pode iniciar até 40 min antes."
        >
          <NumberInput
            value={values.checkin_before_minutes}
            onChange={(v) => set("checkin_before_minutes", v)}
            step="5"
            min="0"
            max="480"
            suffix="min"
          />
        </Field>
        <Field
          label="Minutos após para encerrar automaticamente"
          hint="Quantos minutos após o fim previsto do serviço o sistema força o clock-out automático. Ex: 60 significa que encerrará 1 hora depois do fim."
        >
          <NumberInput
            value={values.checkout_after_minutes}
            onChange={(v) => set("checkout_after_minutes", v)}
            step="5"
            min="0"
            max="480"
            suffix="min"
          />
        </Field>
      </Section>

      {/* Feedback + Botão */}
      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
        >
          <Save className="w-4 h-4" />
          {pending ? "A guardar…" : "Guardar alterações"}
        </button>

        {msg && (
          <div className={`flex items-center gap-2 text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>
            {msg.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            {msg.text}
          </div>
        )}
      </div>
    </form>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</p>
      </div>
      <div className="px-6 py-5 space-y-5">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
      <div>
        <p className="text-sm font-medium text-[var(--color-text-main)]">{label}</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5 leading-relaxed">{hint}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  suffix,
}: {
  value: number;
  onChange: (v: string) => void;
  step?: string;
  min?: string;
  max?: string;
  suffix: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step={step}
        min={min}
        max={max}
        className={`${inputCls} w-32`}
      />
      <span className="text-sm text-[var(--color-text-muted)]">{suffix}</span>
    </div>
  );
}

const inputCls =
  "px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white w-full";
