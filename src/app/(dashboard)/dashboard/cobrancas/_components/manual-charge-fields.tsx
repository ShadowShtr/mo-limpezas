"use client";

// Campos de uma cobrança avulsa — os mesmos para criar e para editar.
//
// Cliente, data, descrição, valor, IVA e notas. Sem local, sem serviço, sem
// hora: uma cobrança avulsa não é um serviço e não finge sê-lo.

import { isValidIsoDateString } from "@/lib/utils";
import type { ManualChargeBillingRow } from "@/domain/billing/daily-billing";
import { parseEurInput } from "./billing-format";

export interface ManualChargeDraft {
  clientId: string;
  chargeDate: string;
  description: string;
  amount: string;
  applyVat: boolean;
  notes: string;
}

export function emptyDraft(chargeDate: string): ManualChargeDraft {
  return { clientId: "", chargeDate, description: "", amount: "", applyVat: true, notes: "" };
}

export function draftFromRow(row: ManualChargeBillingRow): ManualChargeDraft {
  return {
    clientId: row.client_id ?? "",
    chargeDate: row.charge_date,
    description: row.description,
    amount: String(row.value),
    applyVat: row.apply_vat,
    notes: row.notes ?? "",
  };
}

export function validateDraft(d: ManualChargeDraft):
  | { ok: true; value: { clientId: string; chargeDate: string; description: string; amount: number; applyVat: boolean; notes: string | null } }
  | { ok: false; error: string } {
  if (!d.clientId) return { ok: false, error: "Escolha um cliente." };
  if (!isValidIsoDateString(d.chargeDate)) return { ok: false, error: "Data inválida." };
  const description = d.description.trim();
  if (!description) return { ok: false, error: "A descrição é obrigatória." };
  const amount = parseEurInput(d.amount);
  if (amount == null || amount <= 0) return { ok: false, error: "O valor deve ser superior a zero." };
  if (Math.round(amount * 100) / 100 !== amount) return { ok: false, error: "O valor só pode ter até duas casas decimais." };
  return {
    ok: true,
    value: { clientId: d.clientId, chargeDate: d.chargeDate, description, amount, applyVat: d.applyVat, notes: d.notes.trim() || null },
  };
}

const INPUT =
  "w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] disabled:bg-gray-50 disabled:text-gray-500";

export function ManualChargeFields({
  draft, onChange, clients, lockMoney = false, disabled = false,
}: {
  draft: ManualChargeDraft;
  onChange: (next: ManualChargeDraft) => void;
  clients: { id: string; name: string }[];
  lockMoney?: boolean;
  disabled?: boolean;
}) {
  const set = <K extends keyof ManualChargeDraft>(k: K, v: ManualChargeDraft[K]) => onChange({ ...draft, [k]: v });

  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-[var(--color-text-sub)]">
        Cliente
        <select value={draft.clientId} disabled={disabled || lockMoney} onChange={(e) => set("clientId", e.target.value)} className={`${INPUT} mt-1`}>
          <option value="">Escolher cliente…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-[var(--color-text-sub)]">
        Data
        <input
          type="date"
          value={draft.chargeDate}
          disabled={disabled}
          // A mesma guarda de todos os inputs de data da aplicação: um valor
          // malformado a meio da edição nunca chega ao estado.
          onChange={(e) => { if (isValidIsoDateString(e.target.value)) set("chargeDate", e.target.value); }}
          className={`${INPUT} mt-1`}
        />
      </label>
      <label className="block text-xs font-medium text-[var(--color-text-sub)]">
        Descrição
        <input type="text" value={draft.description} disabled={disabled} maxLength={500}
          onChange={(e) => set("description", e.target.value)} className={`${INPUT} mt-1`} placeholder="Ex.: Limpeza extra de vidros" />
      </label>
      <div className="flex items-end gap-3">
        <label className="block flex-1 text-xs font-medium text-[var(--color-text-sub)]">
          Valor (sem IVA)
          <input type="text" inputMode="decimal" value={draft.amount} disabled={disabled || lockMoney}
            onChange={(e) => set("amount", e.target.value)} className={`${INPUT} mt-1`} placeholder="0,00" />
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs font-medium text-[var(--color-text-sub)]">
          <input type="checkbox" checked={draft.applyVat} disabled={disabled || lockMoney}
            onChange={(e) => set("applyVat", e.target.checked)} />
          Aplicar IVA
        </label>
      </div>
      <label className="block text-xs font-medium text-[var(--color-text-sub)]">
        Notas (opcional)
        <textarea value={draft.notes} disabled={disabled} maxLength={2000} rows={2}
          onChange={(e) => set("notes", e.target.value)} className={`${INPUT} mt-1`} />
      </label>
    </div>
  );
}
