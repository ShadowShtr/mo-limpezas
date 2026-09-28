"use client";

// ============================================================================
// «Adicionar cobrança» — duas coisas diferentes, escolhidas à partida
// ============================================================================
//
//   1. Novo serviço         → o MESMO `ServiceCreateSheet` do calendário e da
//                             ficha de cliente. Um caminho de criação, não três.
//   2. Cobrança avulsa      → uma nota de cobrança: cliente, data, descrição,
//                             valor, IVA. Não cria serviço, fatura, linha de
//                             fatura nem movimento de caixa — o caixa só nasce
//                             quando o recebimento for registado.
//
// Perguntar primeiro evita o erro que motivou tudo isto: agendar um serviço
// falso só para ter onde pôr um valor a cobrar.
// ============================================================================

import { useState } from "react";
import { CalendarPlus, ReceiptText, X, Loader2 } from "lucide-react";
import type { ManualChargeInput } from "@/app/actions/manual-charges";
import { ManualChargeFields, emptyDraft, validateDraft, type ManualChargeDraft } from "./manual-charge-fields";

export function AddChargeChooser({
  onClose, onNewService, onManualCharge,
}: {
  onClose: () => void;
  onNewService: () => void;
  onManualCharge: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Adicionar cobrança"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-base font-semibold text-[var(--color-text-main)]">Adicionar cobrança</p>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 hover:bg-[var(--color-background)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2">
          <button type="button" onClick={onNewService}
            className="flex w-full items-start gap-3 rounded-xl border border-[var(--color-border)] p-3 text-left hover:bg-[var(--color-background)]">
            <CalendarPlus className="mt-0.5 h-5 w-5 text-[var(--finance-primary)]" />
            <span>
              <span className="block text-sm font-semibold text-[var(--color-text-main)]">Novo serviço</span>
              <span className="block text-xs text-[var(--color-text-muted)]">Agenda um serviço neste dia, com equipa e local.</span>
            </span>
          </button>
          <button type="button" onClick={onManualCharge}
            className="flex w-full items-start gap-3 rounded-xl border border-[var(--color-border)] p-3 text-left hover:bg-[var(--color-background)]">
            <ReceiptText className="mt-0.5 h-5 w-5 text-violet-600" />
            <span>
              <span className="block text-sm font-semibold text-[var(--color-text-main)]">Cobrança avulsa / Nota de cobrança</span>
              <span className="block text-xs text-[var(--color-text-muted)]">Um valor a cobrar a um cliente, sem serviço agendado.</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function ManualChargeCreateSheet({
  date, clients, onClose, onCreate,
}: {
  date: string;
  clients: { id: string; name: string }[];
  onClose: () => void;
  onCreate: (input: ManualChargeInput) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [draft, setDraft] = useState<ManualChargeDraft>(() => emptyDraft(date));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    // Anti-duplo-clique: um segundo clique durante a gravação criaria outra nota.
    if (saving) return;
    setError(null);
    const v = validateDraft(draft);
    if (!v.ok) { setError(v.error); return; }
    setSaving(true);
    const r = await onCreate(v.value);
    setSaving(false);
    if (!r.ok) setError(r.error);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Nova cobrança avulsa"
    >
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <p className="text-base font-semibold text-[var(--color-text-main)]">Nova cobrança avulsa</p>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Fechar" className="rounded-lg p-2 hover:bg-[var(--color-background)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <ManualChargeFields draft={draft} onChange={setDraft} clients={clients} disabled={saving} />
          <button type="button" disabled={saving} onClick={() => void submit()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--finance-primary)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Criar cobrança
          </button>
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
