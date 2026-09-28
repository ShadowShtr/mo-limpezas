"use client";

// ============================================================================
// Editor de uma linha do Diário — recebimento e (na avulsa) os dados da nota
// ============================================================================
//
// O recebimento vive aqui, e não na linha. Quatro formas, as mesmas para os
// dois tipos: retirar recebimento, 50%, 100% e um valor livre em €. Cada uma é
// UMA chamada a UMA RPC, que grava estado e caixa na mesma transação.
//
// Na cobrança avulsa editam-se também os dados. Com recebimento registado, a
// base recusa mudar valor, IVA e cliente — e o formulário diz isso antes de o
// pedido partir, em vez de deixar a pessoa descobrir pelo erro.
// ============================================================================

import { useState } from "react";
import Link from "next/link";
import { X, Loader2, CalendarDays } from "lucide-react";
import {
  billingOutstanding,
  billingReceived,
  billingTotal,
  hasRegisteredPayment,
  statusForCustomAmount,
  type BillingPaymentStatus,
  type DailyBillingRow,
  type ManualChargeBillingRow,
} from "@/domain/billing/daily-billing";
import type { ManualChargePatch } from "@/app/actions/manual-charges";
import { lisbonDateOf } from "@/lib/lisbon-time";
import { fmtEur, parseEurInput } from "./billing-format";
import { ManualChargeFields, type ManualChargeDraft, draftFromRow, validateDraft } from "./manual-charge-fields";

type Result = { ok: true } | { ok: false; error: string };

interface Props {
  row: DailyBillingRow;
  vatRate: number;
  busy: boolean;
  clients: { id: string; name: string }[];
  onClose: () => void;
  onPayment: (status: BillingPaymentStatus, amount: number | null) => Promise<Result>;
  onSaveManual: (patch: ManualChargePatch) => Promise<Result>;
}

export function BillingEditorSheet({ row, vatRate, busy, clients, onClose, onPayment, onSaveManual }: Props) {
  const total = billingTotal(row, vatRate);
  const received = billingReceived(row, vatRate);
  const outstanding = billingOutstanding(row, vatRate);
  const [amountInput, setAmountInput] = useState(row.paid_amount != null ? String(row.paid_amount) : "");
  const [error, setError] = useState<string | null>(null);
  const parsed = parseEurInput(amountInput);

  async function pay(status: BillingPaymentStatus, amount: number | null) {
    setError(null);
    const r = await onPayment(status, amount);
    if (!r.ok) setError(r.error);
  }

  const titulo = row.type === "service" ? "Serviço" : "Cobrança avulsa";

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Editar ${titulo.toLowerCase()}`}
    >
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">{titulo}</p>
            <p className="text-base font-semibold text-[var(--color-text-main)]">{row.client_name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-2 hover:bg-[var(--color-background)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-5 py-5">
          {row.type === "service" && (
            <section className="space-y-1 text-sm">
              <p className="text-[var(--color-text-main)]">{row.location_name}</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {row.reference_number ? `#${row.reference_number} · ` : ""}
                {row.is_avenca ? "Avença mensal — o valor é a fatia deste serviço" : "Serviço pontual ou recorrente"}
              </p>
              <Link
                href={`/dashboard/calendario?date=${lisbonDateOf(row.scheduled_start)}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--finance-primary)] hover:underline"
              >
                <CalendarDays className="h-3.5 w-3.5" /> Editar o serviço no calendário
              </Link>
            </section>
          )}

          {/* ── Recebimento ─────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Recebimento</p>
              <p className="text-xs text-[var(--color-text-muted)]">Total {fmtEur(total)}</p>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              Recebido <span className="font-semibold text-green-700">{fmtEur(received)}</span>
              {outstanding > 0 && <> · falta <span className="font-semibold text-amber-700">{fmtEur(outstanding)}</span></>}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" disabled={busy} onClick={() => void pay("nao_informado", null)}
                className="rounded-lg border border-[var(--color-border)] px-2 py-2 text-xs font-semibold hover:bg-[var(--color-background)] disabled:opacity-50">
                Por pagar
              </button>
              <button type="button" disabled={busy} onClick={() => void pay("sinal_50", null)}
                className="rounded-lg border border-amber-300 px-2 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50">
                50%
              </button>
              <button type="button" disabled={busy} onClick={() => void pay("pago_total", null)}
                className="rounded-lg border border-green-300 px-2 py-2 text-xs font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50">
                100%
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                aria-label="Valor recebido (€)"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder={`Valor recebido (total ${total.toFixed(2)})`}
                className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
              />
              <button
                type="button"
                disabled={busy || parsed == null || parsed < 0}
                onClick={() => {
                  if (parsed == null) return;
                  // Estado coerente com o valor — as RPCs recusam o incoerente.
                  const status = statusForCustomAmount(parsed, total);
                  void pay(status, status === "nao_informado" ? null : parsed);
                }}
                className="rounded-lg bg-[var(--finance-primary)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                Guardar valor
              </button>
            </div>
            {busy && <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> A gravar…</p>}
            {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          </section>

          {row.type === "manual_charge" && (
            <ManualChargeEditSection row={row} clients={clients} busy={busy} onSave={onSaveManual} />
          )}
        </div>
      </div>
    </div>
  );
}

function ManualChargeEditSection({
  row, clients, busy, onSave,
}: {
  row: ManualChargeBillingRow;
  clients: { id: string; name: string }[];
  busy: boolean;
  onSave: (patch: ManualChargePatch) => Promise<Result>;
}) {
  const [draft, setDraft] = useState<ManualChargeDraft>(() => draftFromRow(row));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const locked = hasRegisteredPayment(row);
  // Um cliente entretanto inactivo não está na lista — mas continua a ser o
  // cliente desta cobrança, e o selector tem de o mostrar.
  const options = row.client_id && !clients.some((c) => c.id === row.client_id)
    ? [{ id: row.client_id, name: row.client_name }, ...clients]
    : clients;

  async function save() {
    setError(null);
    setSaved(false);
    const v = validateDraft(draft);
    if (!v.ok) { setError(v.error); return; }
    // Só o que mudou. Mandar valor/IVA iguais sobre uma cobrança com
    // recebimento faria a base recusar uma alteração que não existe.
    const patch: ManualChargePatch = {};
    if (v.value.clientId !== row.client_id) patch.clientId = v.value.clientId;
    if (v.value.chargeDate !== row.charge_date) patch.chargeDate = v.value.chargeDate;
    if (v.value.description !== row.description) patch.description = v.value.description;
    if (v.value.amount !== row.value) patch.amount = v.value.amount;
    if (v.value.applyVat !== row.apply_vat) patch.applyVat = v.value.applyVat;
    if ((v.value.notes ?? null) !== (row.notes ?? null)) patch.notes = v.value.notes;
    if (Object.keys(patch).length === 0) { setSaved(true); return; }
    const r = await onSave(patch);
    if (r.ok) setSaved(true);
    else setError(r.error);
  }

  return (
    <section className="space-y-3 border-t border-[var(--color-border)] pt-5">
      <p className="text-sm font-semibold text-[var(--color-text-main)]">Dados da cobrança</p>
      {locked && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Já tem recebimento registado: valor, IVA e cliente ficam bloqueados. Para os alterar, retire primeiro o recebimento.
        </p>
      )}
      <ManualChargeFields draft={draft} onChange={setDraft} clients={options} lockMoney={locked} disabled={busy} />
      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        className="w-full rounded-lg bg-[var(--finance-primary)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        Guardar alterações
      </button>
      {saved && !error && <p className="text-xs text-green-700">Alterações guardadas.</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </section>
  );
}
