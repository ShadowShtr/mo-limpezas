"use client";

import { Euro, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import type { DailyBillingRow } from "@/app/actions/daily-billing";

type PaymentStatus = "nao_informado" | "sinal_50" | "pago_total";

export function formatBillingCurrency(value: number) {
  return value.toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
}

export function PaymentRow({
  row, vatRate, showDate = false, saving, editing, amountInput,
  onAmountInput, onStartEdit, onCancelEdit, onApply,
}: {
  row: DailyBillingRow;
  vatRate: number;
  showDate?: boolean;
  saving: boolean;
  editing: boolean;
  amountInput: string;
  onAmountInput: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApply: (status: PaymentStatus, amount?: number | null) => void;
}) {
  const total = row.value * (row.apply_vat ? 1 + vatRate / 100 : 1);
  const received = row.paid_amount != null
    ? row.paid_amount
    : row.payment_status === "pago_total" ? total
    : row.payment_status === "sinal_50" ? total / 2
    : 0;
  const parsedAmount = amountInput.trim() === "" ? null : Number(amountInput.replace(",", "."));
  const stateButton = (active: boolean, className: string) =>
    `px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
      active
        ? className
        : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:bg-[var(--color-background)]"
    }`;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
            {row.client_name}
            {row.is_avenca && (
              <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 align-middle">
                Avença
              </span>
            )}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] truncate">
            {row.location_name}
            {showDate && <> · {format(parseISO(row.scheduled_start), "d MMM", { locale: pt })}</>}
            {row.reference_number && <> · #{row.reference_number}</>}
          </p>
        </div>

        <div className="text-right shrink-0 w-28">
          <p className="text-sm font-bold text-[var(--color-text-main)]">{formatBillingCurrency(total)}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {row.apply_vat ? `c/ IVA · base ${formatBillingCurrency(row.value)}` : "sem IVA"}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--finance-primary)] mx-6" />
          ) : (
            <>
              <button
                disabled={saving}
                onClick={() => onApply("nao_informado", null)}
                className={stateButton(row.payment_status === "nao_informado" && row.paid_amount == null, "bg-gray-600 text-white border-gray-600")}
              >
                Por pagar
              </button>
              <button
                disabled={saving}
                onClick={() => onApply("sinal_50", null)}
                className={stateButton(row.payment_status === "sinal_50" && row.paid_amount == null, "bg-amber-500 text-white border-amber-500")}
              >
                50%
              </button>
              <button
                disabled={saving}
                onClick={() => onApply("pago_total", null)}
                className={stateButton(row.payment_status === "pago_total" && row.paid_amount == null, "bg-green-600 text-white border-green-600")}
              >
                100%
              </button>
              <button
                disabled={saving}
                onClick={editing ? onCancelEdit : onStartEdit}
                title="Registar valor recebido (€)"
                className={stateButton(row.paid_amount != null, "bg-[var(--finance-primary)] text-white border-[var(--finance-primary)]")}
              >
                <Euro className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {(received > 0 || row.paid_at) && !editing && (
        <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
          Recebido: <span className="font-semibold text-green-700">{formatBillingCurrency(received)}</span>
          {received < total && <> · falta <span className="font-semibold text-amber-700">{formatBillingCurrency(total - received)}</span></>}
          {row.paid_at && <> · registado {format(parseISO(row.paid_at), "d MMM 'às' HH:mm", { locale: pt })}</>}
        </p>
      )}

      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            autoFocus
            value={amountInput}
            onChange={(event) => onAmountInput(event.target.value)}
            placeholder={`Valor recebido (total: ${total.toFixed(2)})`}
            className="w-56 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
          />
          <button
            disabled={saving || parsedAmount == null || !Number.isFinite(parsedAmount) || parsedAmount < 0}
            onClick={() => {
              if (parsedAmount == null) return;
              const status = parsedAmount >= total - 0.005
                ? "pago_total"
                : parsedAmount > 0 ? "sinal_50" : "nao_informado";
              onApply(status, parsedAmount);
            }}
            className="px-3 py-1.5 rounded-lg bg-[var(--finance-primary)] text-white text-xs font-semibold hover:bg-[var(--finance-primary-hover)] transition-colors disabled:opacity-50"
          >
            Guardar
          </button>
          <button
            onClick={onCancelEdit}
            className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}
