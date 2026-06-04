"use client";

import { X, Download, Loader2, CheckCircle, Banknote, XCircle, Send } from "lucide-react";
import type { Invoice } from "@/app/actions/invoices";

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onStatusChange: (status: Invoice["status"]) => void;
  onExportPdf: () => void;
  isPending: boolean;
}

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString("pt-PT") : "—";
}

const STATUS_LABEL: Record<Invoice["status"], string> = {
  rascunho:  "Rascunho",
  pendente:  "Pendente",
  pago:      "Pago",
  vencido:   "Vencido",
  cancelado: "Cancelado",
};
const STATUS_COLOR: Record<Invoice["status"], string> = {
  rascunho:  "bg-gray-100 text-gray-600",
  pendente:  "bg-amber-100 text-amber-700",
  pago:      "bg-green-100 text-green-700",
  vencido:   "bg-red-100 text-red-700",
  cancelado: "bg-gray-100 text-gray-400",
};

export function InvoiceDetailSheet({ invoice, onClose, onStatusChange, onExportPdf, isPending }: Props) {
  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--color-text-main)] font-mono">
                {invoice.invoice_number}
              </h2>
              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[invoice.status]}`}>
                {STATUS_LABEL[invoice.status]}
              </span>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">{invoice.client_name}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Info */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <p className="text-[var(--color-text-muted)] mb-0.5">Data emissão</p>
              <p className="font-medium text-[var(--color-text-main)]">{fmtDate(invoice.invoice_date)}</p>
            </div>
            <div>
              <p className="text-[var(--color-text-muted)] mb-0.5">Vencimento</p>
              <p className={`font-medium ${invoice.status === "vencido" ? "text-red-600" : "text-[var(--color-text-main)]"}`}>
                {fmtDate(invoice.due_date)}
              </p>
            </div>
            <div>
              <p className="text-[var(--color-text-muted)] mb-0.5">Período</p>
              <p className="font-medium text-[var(--color-text-main)]">
                {fmtDate(invoice.period_start)} – {fmtDate(invoice.period_end)}
              </p>
            </div>
          </div>
        </div>

        {/* Itens */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
            Serviços ({invoice.items.length})
          </h3>
          <div className="space-y-1">
            {invoice.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between py-2 border-b border-[var(--color-border)] last:border-0"
              >
                <p className="text-sm text-[var(--color-text-main)] flex-1 pr-4">{item.description}</p>
                <p className="text-sm font-medium text-[var(--color-text-sub)] shrink-0">{fmtEur(item.total)}</p>
              </div>
            ))}
          </div>

          {/* Totais */}
          <div className="mt-5 pt-4 border-t border-[var(--color-border)] space-y-2">
            <div className="flex justify-between text-sm text-[var(--color-text-sub)]">
              <span>Subtotal</span>
              <span>{fmtEur(invoice.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm text-[var(--color-text-sub)]">
              <span>IVA ({invoice.vat_rate}%)</span>
              <span>{fmtEur(invoice.vat_amount)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-[var(--color-primary)] pt-1 border-t border-[var(--color-border)]">
              <span>Total</span>
              <span>{fmtEur(invoice.total)}</span>
            </div>
          </div>
        </div>

        {/* Ações */}
        <div className="border-t border-[var(--color-border)] px-6 py-4 space-y-2">
          {/* Transições de estado */}
          <div className="flex gap-2">
            {invoice.status === "rascunho" && (
              <button
                onClick={() => onStatusChange("pendente")}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Marcar como enviada
              </button>
            )}
            {invoice.status === "pendente" && (
              <button
                onClick={() => onStatusChange("pago")}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Banknote className="w-4 h-4" />}
                Marcar como paga
              </button>
            )}
            {invoice.status === "pendente" && (
              <button
                onClick={() => onStatusChange("vencido")}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <XCircle className="w-4 h-4" />
                Vencida
              </button>
            )}
            {(invoice.status === "pago") && (
              <div className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-green-50 text-green-700 text-sm font-medium">
                <CheckCircle className="w-4 h-4" />
                Pago em {fmtDate(invoice.paid_at)}
              </div>
            )}
          </div>

          <button
            onClick={onExportPdf}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            <Download className="w-4 h-4" />
            Exportar PDF
          </button>
        </div>
      </div>
    </>
  );
}
