"use client";

// ============================================================================
// Uma linha do Diário — serviço ou cobrança avulsa
// ============================================================================
//
// 🔴 Sem botões de pagamento na linha. «Por pagar / 50% / 100% / €» a um clique
//    de distância, em cada linha, tornava fácil registar dinheiro na linha
//    errada — e cada clique é um movimento de caixa. O recebimento passa para
//    dentro do editor, onde se vê o que se está a alterar antes de confirmar.
//
// A linha mostra o estado e oferece duas acções, claras: Editar e Excluir.
// ============================================================================

import { Loader2, Pencil, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import {
  billingOutstanding,
  billingReceived,
  billingTotal,
  type DailyBillingRow,
} from "@/domain/billing/daily-billing";
import { fmtEur } from "./billing-format";

export function paymentLabel(row: DailyBillingRow, vatRate: number): { text: string; tone: "grey" | "amber" | "green" } {
  const received = billingReceived(row, vatRate);
  const outstanding = billingOutstanding(row, vatRate);
  if (received <= 0) return { text: "Por pagar", tone: "grey" };
  if (outstanding <= 0) return { text: "Pago", tone: "green" };
  if (row.paid_amount == null && row.payment_status === "sinal_50") return { text: "50% recebido", tone: "amber" };
  return { text: `Recebido ${fmtEur(received)}`, tone: "amber" };
}

const TONE: Record<"grey" | "amber" | "green", string> = {
  grey: "bg-gray-100 text-gray-700 border-gray-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  green: "bg-green-50 text-green-700 border-green-200",
};

export function BillingRow({
  row,
  vatRate,
  showDate = false,
  busy,
  onEdit,
  onDelete,
}: {
  row: DailyBillingRow;
  vatRate: number;
  showDate?: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const total = billingTotal(row, vatRate);
  const outstanding = billingOutstanding(row, vatRate);
  const estado = paymentLabel(row, vatRate);

  return (
    <div className="px-4 py-3" data-billing-row={`${row.type}:${row.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
            {row.client_name}
            {row.type === "service" && row.is_avenca && (
              <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 align-middle">
                Avença
              </span>
            )}
            {row.type === "manual_charge" && (
              <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 align-middle">
                Cobrança avulsa
              </span>
            )}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] truncate">
            {row.type === "service" ? (
              <>
                {row.location_name}
                {showDate && <> · {format(parseISO(row.scheduled_start), "d MMM", { locale: pt })}</>}
                {row.reference_number && <> · #{row.reference_number}</>}
              </>
            ) : (
              <>
                {row.description}
                {showDate && <> · {format(parseISO(row.charge_date), "d MMM", { locale: pt })}</>}
              </>
            )}
          </p>
        </div>

        <div className="text-right shrink-0 w-28">
          <p className="text-sm font-bold text-[var(--color-text-main)]">{fmtEur(total)}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {row.apply_vat ? `c/ IVA · base ${fmtEur(row.value)}` : "sem IVA"}
          </p>
        </div>

        <div className="shrink-0 w-32 text-right">
          <span className={`inline-block text-[11px] font-semibold px-2 py-1 rounded-full border ${TONE[estado.tone]}`}>
            {estado.text}
          </span>
          {outstanding > 0 && estado.tone === "amber" && (
            <p className="text-[11px] text-amber-700 mt-0.5">falta {fmtEur(outstanding)}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--finance-primary)] mx-8" aria-label="A gravar" />
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" /> Editar
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-red-200 text-red-700 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" /> Excluir
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
