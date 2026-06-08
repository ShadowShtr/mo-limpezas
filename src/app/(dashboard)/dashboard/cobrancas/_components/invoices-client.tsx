"use client";

import { useState, useTransition } from "react";
import {
  Receipt, RefreshCw, Loader2, AlertCircle,
  Eye, Trash2, Download, FileSpreadsheet, X,
} from "lucide-react";
import {
  generateInvoices,
  updateInvoiceStatus,
  deleteInvoice,
  type Invoice,
} from "@/app/actions/invoices";
import { InvoiceDetailSheet } from "./invoice-detail-sheet";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  initialInvoices: Invoice[];
  companyId: string;
  mesParam: string;
  year: number;
  month: number;
  mesLabel: string;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function InvoicesClient({ initialInvoices, companyId, mesParam, year, month, mesLabel }: Props) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [viewing,  setViewing]  = useState<Invoice | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [paymentModal, setPaymentModal] = useState<{ id: string } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("transferencia");

  // KPIs
  const totalFaturado  = invoices.reduce((s, i) => s + i.total, 0);
  const totalRecebido  = invoices.filter((i) => i.status === "pago").reduce((s, i) => s + i.total, 0);
  const totalPendente  = invoices.filter((i) => i.status === "pendente").reduce((s, i) => s + i.total, 0);
  const totalVencido   = invoices.filter((i) => i.status === "vencido").reduce((s, i) => s + i.total, 0);

  function handleGenerate() {
    setError(null);
    startTransition(async () => {
      const res = await generateInvoices(companyId, year, month);
      if (res.ok) setInvoices(res.invoices);
      else setError(res.error);
    });
  }

  function handleStatusChange(id: string, status: Invoice["status"]) {
    if (status === "pago") {
      setPaymentModal({ id });
      return;
    }
    applyStatusChange(id, status, undefined);
  }

  function applyStatusChange(id: string, status: Invoice["status"], method: string | undefined) {
    setError(null);
    startTransition(async () => {
      const res = await updateInvoiceStatus(id, status, method);
      if (res.ok) {
        setInvoices((prev) =>
          prev.map((inv) =>
            inv.id === id
              ? { ...inv, status, paid_at: status === "pago" ? new Date().toISOString() : inv.paid_at, payment_method: method ?? inv.payment_method }
              : inv,
          ),
        );
        if (viewing?.id === id) setViewing((v) => v ? { ...v, status } : null);
      } else {
        setError(res.error ?? "Erro.");
      }
    });
  }

  function confirmPayment() {
    if (!paymentModal) return;
    applyStatusChange(paymentModal.id, "pago", paymentMethod);
    setPaymentModal(null);
  }

  function handleDelete(id: string) {
    if (!confirm("Eliminar este rascunho?")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteInvoice(id);
      if (res.ok) {
        setInvoices((prev) => prev.filter((i) => i.id !== id));
        if (viewing?.id === id) setViewing(null);
      } else {
        setError(res.error ?? "Erro.");
      }
    });
  }

  async function handleExportPdf(inv: Invoice) {
    const { default: jsPDF } = await import("jspdf");
    const { default: autoTable } = await import("jspdf-autotable");

    const doc    = new jsPDF({ unit: "mm", format: "a4" });
    const pageW  = 210;
    const margin = 14;

    // Cabeçalho
    doc.setFillColor(22, 163, 74);
    doc.rect(0, 0, pageW, 30, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(15);
    doc.setFont("helvetica", "bold");
    doc.text("Documento de Cobrança", margin, 12);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`Nº ${inv.invoice_number}`, margin, 20);
    doc.text(`Emitido: ${fmtDate(inv.invoice_date)}`, pageW - margin - 45, 20);
    doc.setTextColor(0, 0, 0);

    // Info fatura
    let y = 38;
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Cliente:", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(inv.client_name, margin + 22, y);
    y += 7;
    doc.setFont("helvetica", "bold");
    doc.text("Período:", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(`${fmtDate(inv.period_start)} a ${fmtDate(inv.period_end)}`, margin + 22, y);
    y += 7;
    doc.setFont("helvetica", "bold");
    doc.text("Vencimento:", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(fmtDate(inv.due_date), margin + 28, y);

    // Tabela de itens
    autoTable(doc, {
      startY: y + 10,
      margin: { left: margin, right: margin },
      head: [["Descrição", "Qtd.", "Valor Unit. (€)", "Total (€)"]],
      body: inv.items.map((it) => [
        it.description,
        it.quantity.toString(),
        fmtEur(it.unit_price),
        fmtEur(it.total),
      ]),
      headStyles:  { fillColor: [22, 163, 74], textColor: 255, fontStyle: "bold", fontSize: 9 },
      bodyStyles:  { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: { 0: { cellWidth: 95 }, 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalY = (doc as any).lastAutoTable.finalY + 8;
    const rMargin = pageW - margin;

    doc.setFontSize(10);
    doc.text("Subtotal:", rMargin - 60, finalY);
    doc.text(fmtEur(inv.subtotal), rMargin, finalY, { align: "right" });

    if (inv.vat_rate === 0) {
      doc.text("IVA:", rMargin - 60, finalY + 7);
      doc.text("Isento de IVA", rMargin, finalY + 7, { align: "right" });
    } else {
      doc.text(`IVA (${inv.vat_rate}%):`, rMargin - 60, finalY + 7);
      doc.text(fmtEur(inv.vat_amount), rMargin, finalY + 7, { align: "right" });
    }

    doc.setDrawColor(22, 163, 74);
    doc.line(rMargin - 65, finalY + 10, rMargin, finalY + 10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(22, 163, 74);
    doc.text("TOTAL:", rMargin - 60, finalY + 18);
    doc.text(fmtEur(inv.total), rMargin, finalY + 18, { align: "right" });

    doc.save(`${inv.invoice_number.replace("/", "-")}.pdf`);
  }

  function handleExportCsv() {
    const headers = ["Nº Fatura", "Cliente", "Data", "Vencimento", "Subtotal", "IVA", "Total", "Estado"];
    const rows = invoices.map((inv) => [
      inv.invoice_number,
      inv.client_name,
      fmtDate(inv.invoice_date),
      fmtDate(inv.due_date),
      inv.subtotal.toFixed(2),
      inv.vat_amount.toFixed(2),
      inv.total.toFixed(2),
      STATUS_LABEL[inv.status],
    ]);
    const lines = [headers, ...rows].map((r) =>
      r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
    );
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `cobrancas-${mesParam}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="space-y-5">
        {/* Filtro + ações */}
        <div className="flex flex-wrap items-end gap-3">
          <form method="GET" className="flex items-end gap-2">
            <div>
              <label className="block text-xs text-[var(--color-text-muted)] mb-1">Mês</label>
              <input
                type="month"
                name="mes"
                defaultValue={mesParam}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <button type="submit" className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
              Ver
            </button>
          </form>

          <div className="flex-1" />

          <button
            onClick={handleGenerate}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Gerar cobranças
          </button>

          {invoices.length > 0 && (
            <button
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <FileSpreadsheet className="w-4 h-4" />
              CSV
            </button>
          )}
        </div>

        {/* Erro */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* KPIs */}
        {invoices.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Total Faturado"  value={fmtEur(totalFaturado)} highlight />
            <KpiCard label="Recebido"        value={fmtEur(totalRecebido)} />
            <KpiCard label="Pendente"        value={fmtEur(totalPendente)} warn={totalPendente > 0} />
            <KpiCard label="Vencido"         value={fmtEur(totalVencido)}  danger={totalVencido > 0} />
          </div>
        )}

        {/* Tabela */}
        {invoices.length === 0 ? (
          <div className="py-16 text-center">
            <Receipt className="w-10 h-10 mx-auto text-[var(--color-text-muted)] mb-3" />
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              Sem cobranças para este período. Clica em <strong>Gerar cobranças</strong> para criar automaticamente a partir dos serviços concluídos.
            </p>
            <button
              onClick={handleGenerate}
              disabled={isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Gerar cobranças de {mesLabel}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Nº</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Cliente</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Data</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Vencimento</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Subtotal</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">IVA</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Total</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Estado</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="bg-white hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--color-text-sub)]">{inv.invoice_number}</td>
                    <td className="px-4 py-3 font-medium text-[var(--color-text-main)]">{inv.client_name}</td>
                    <td className="px-4 py-3 text-[var(--color-text-sub)]">{fmtDate(inv.invoice_date)}</td>
                    <td className="px-4 py-3 text-[var(--color-text-sub)]">
                      <span className={inv.status === "vencido" ? "text-red-600 font-medium" : ""}>
                        {fmtDate(inv.due_date)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--color-text-sub)]">{fmtEur(inv.subtotal)}</td>
                    <td className="px-4 py-3 text-right text-[var(--color-text-muted)]">{fmtEur(inv.vat_amount)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-[var(--color-text-main)]">{fmtEur(inv.total)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[inv.status]}`}>
                        {STATUS_LABEL[inv.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setViewing(inv)}
                          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
                          title="Ver detalhes"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleExportPdf(inv)}
                          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
                          title="Exportar PDF"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        {inv.status === "rascunho" && (
                          <button
                            onClick={() => handleDelete(inv.id)}
                            disabled={isPending}
                            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                            title="Eliminar rascunho"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)] bg-[var(--color-background)]">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-[var(--color-text-muted)] uppercase">
                    Total ({invoices.length} documento{invoices.length !== 1 ? "s" : ""})
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--color-text-main)]">
                    {fmtEur(invoices.reduce((s, i) => s + i.subtotal, 0))}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--color-text-muted)]">
                    {fmtEur(invoices.reduce((s, i) => s + i.vat_amount, 0))}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-[var(--color-primary)]">
                    {fmtEur(totalFaturado)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {viewing && (
        <InvoiceDetailSheet
          invoice={viewing}
          onClose={() => setViewing(null)}
          onStatusChange={(status) => handleStatusChange(viewing.id, status)}
          onExportPdf={() => handleExportPdf(viewing)}
          isPending={isPending}
        />
      )}

      {/* Modal forma de pagamento */}
      {paymentModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setPaymentModal(null)} />
          <div className="relative z-10 bg-white rounded-xl shadow-xl border border-[var(--color-border)] p-6 w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-[var(--color-text-main)]">Registar pagamento</h3>
              <button onClick={() => setPaymentModal(null)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-5">
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-2">Forma de pagamento</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: "transferencia", label: "Transferência" },
                  { value: "mbway", label: "MBWay" },
                  { value: "cheque", label: "Cheque" },
                  { value: "numerario", label: "Numerário" },
                  { value: "debito_direto", label: "Débito Direto" },
                  { value: "outro", label: "Outro" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPaymentMethod(opt.value)}
                    className={`py-2 px-3 rounded-lg border text-sm font-medium transition-colors text-left ${
                      paymentMethod === opt.value
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                        : "border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setPaymentModal(null)}
                className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={confirmPayment}
                disabled={isPending}
                className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Confirmar pago"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, highlight, warn, danger,
}: { label: string; value: string; highlight?: boolean; warn?: boolean; danger?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-white"}`}>
      <p className="text-xs text-[var(--color-text-muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${highlight ? "text-[var(--color-primary)]" : warn ? "text-amber-600" : danger ? "text-red-600" : "text-[var(--color-text-main)]"}`}>
        {value}
      </p>
    </div>
  );
}
