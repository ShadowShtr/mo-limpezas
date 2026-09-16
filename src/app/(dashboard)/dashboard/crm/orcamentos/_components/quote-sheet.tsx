"use client";

// ============================================================================
// Criar um orçamento
// ============================================================================
//
// O total atualiza-se enquanto se escreve, com `computeQuoteTotals`.
//
// 🔴 Esse cálculo é para VER. O que fica gravado é o que a RPC calcula, e os
//    dois têm de dar o mesmo número — `crm-quote-totals-parity.pg.test.ts`
//    corre os mesmos casos nos dois caminhos e compara cêntimo a cêntimo. Se
//    divergissem, o utilizador via um valor antes de gravar e outro depois.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { computeLineTotal, computeQuoteTotals, formatEur } from "@/domain/crm/quote-totals";
import {
  QUOTE_UNITS,
  QUOTE_UNIT_LABELS,
  QUOTE_PRICING_KINDS,
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_DEFAULT_VALIDITY_DAYS,
} from "@/lib/crm/quotes";
import { todayInLisbon, addDaysToDateString } from "@/lib/lisbon-time";
import { createQuote } from "@/app/actions/crm-orcamentos";
import type { LeadRow } from "@/app/actions/crm-leads";

const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

interface Linha {
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
}

interface Props {
  leads: LeadRow[];
  vatRate: number;
  leadFixa?: LeadRow;
  onClose: () => void;
  onDone: (numero: string) => void;
}

const LINHA_VAZIA: Linha = { description: "", quantity: "1", unit: "servico", unit_price: "" };

export function QuoteSheet({ leads, vatRate, leadFixa, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [erros, setErros] = useState<Record<string, string[]>>({});

  const hoje = todayInLisbon();

  const [leadId, setLeadId] = useState(leadFixa?.id ?? "");
  const [issueDate, setIssueDate] = useState(hoje);
  const [validUntil, setValidUntil] = useState(
    addDaysToDateString(hoje, QUOTE_DEFAULT_VALIDITY_DAYS),
  );
  const [pricingKind, setPricingKind] = useState("pontual");
  const [discountPct, setDiscountPct] = useState("0");
  const [applyVat, setApplyVat] = useState(true);
  const [proposedFrequency, setProposedFrequency] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [linhas, setLinhas] = useState<Linha[]>([{ ...LINHA_VAZIA }]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const totais = computeQuoteTotals(
    linhas.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
    { discountPct: Number(discountPct), applyVat, vatRatePct: vatRate },
  );

  function alterarLinha(i: number, campo: keyof Linha, valor: string) {
    setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));
  }

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErros({});

    const items = linhas
      // Uma linha em branco no fim é normal enquanto se escreve; não deve
      // impedir gravar nem ir para o documento.
      .filter((l) => l.description.trim() !== "")
      .map((l) => ({
        description: l.description,
        quantity: Number(l.quantity) || 0,
        unit: l.unit as (typeof QUOTE_UNITS)[number],
        unit_price: Number(l.unit_price) || 0,
      }));

    if (items.length === 0) {
      toast("Um orçamento tem de ter pelo menos uma linha com descrição.", "error");
      return;
    }

    startTransition(async () => {
      const res = await createQuote({
        leadId,
        clientId: null,
        issueDate,
        validUntil,
        pricingKind: pricingKind as (typeof QUOTE_PRICING_KINDS)[number],
        discountPct: Number(discountPct) || 0,
        applyVat,
        proposedFrequency: proposedFrequency || null,
        paymentTerms: paymentTerms || null,
        notes: notes || null,
        internalNotes: internalNotes || null,
        items,
      });

      if (!res.ok) {
        if (res.error.fieldErrors) setErros(res.error.fieldErrors);
        toast(res.error.message, "error");
        return;
      }
      onDone(res.data.number);
    });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-orcamento"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <form onSubmit={submeter} className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 id="titulo-orcamento" className="text-[15px] font-semibold">Novo orçamento</h2>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Fechar" className="rounded-lg p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[12.5px] font-medium">
              Lead<span className="ml-0.5 text-red-500">*</span>
              <select
                value={leadId}
                onChange={(e) => setLeadId(e.target.value)}
                disabled={Boolean(leadFixa)}
                required
                className={CAMPO}
              >
                <option value="">Escolha a lead…</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              {erros.leadId?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">{erros.leadId[0]}</span>
              )}
            </label>

            <label className="block text-[12.5px] font-medium">
              Tipo de preço
              <select value={pricingKind} onChange={(e) => setPricingKind(e.target.value)} className={CAMPO}>
                {QUOTE_PRICING_KINDS.map((k) => (
                  <option key={k} value={k}>{QUOTE_PRICING_KIND_LABELS[k]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[12.5px] font-medium">
              Data
              <input
                type="date"
                value={issueDate}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) setIssueDate(v);
                }}
                required
                className={CAMPO}
              />
            </label>
            <label className="block text-[12.5px] font-medium">
              Válido até
              <input
                type="date"
                value={validUntil}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) setValidUntil(v);
                }}
                required
                className={CAMPO}
              />
              {erros.validUntil?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">{erros.validUntil[0]}</span>
              )}
            </label>
          </div>

          {/* ── Linhas ── */}
          <div>
            <p className="text-[12.5px] font-medium">Linhas do orçamento</p>
            <div className="mt-2 space-y-2">
              {linhas.map((l, i) => (
                <div
                  key={i}
                  className="rounded-lg border p-2.5"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <div className="flex gap-2">
                    <input
                      value={l.description}
                      onChange={(e) => alterarLinha(i, "description", e.target.value)}
                      placeholder="Descrição do trabalho"
                      maxLength={500}
                      className="flex-1 rounded-lg border px-3 py-2 text-[13px]"
                      style={{ borderColor: "var(--color-border)" }}
                      aria-label={`Descrição da linha ${i + 1}`}
                    />
                    {linhas.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLinhas((a) => a.filter((_, idx) => idx !== i))}
                        aria-label={`Remover linha ${i + 1}`}
                        className="shrink-0 rounded-lg border px-2"
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.quantity}
                      onChange={(e) => alterarLinha(i, "quantity", e.target.value)}
                      placeholder="Qtd."
                      className="rounded-lg border px-2 py-1.5 text-[13px]"
                      style={{ borderColor: "var(--color-border)" }}
                      aria-label={`Quantidade da linha ${i + 1}`}
                    />
                    <select
                      value={l.unit}
                      onChange={(e) => alterarLinha(i, "unit", e.target.value)}
                      className="rounded-lg border px-2 py-1.5 text-[13px]"
                      style={{ borderColor: "var(--color-border)" }}
                      aria-label={`Unidade da linha ${i + 1}`}
                    >
                      {QUOTE_UNITS.map((u) => (
                        <option key={u} value={u}>{QUOTE_UNIT_LABELS[u]}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.unit_price}
                      onChange={(e) => alterarLinha(i, "unit_price", e.target.value)}
                      placeholder="Preço €"
                      className="rounded-lg border px-2 py-1.5 text-[13px]"
                      style={{ borderColor: "var(--color-border)" }}
                      aria-label={`Preço unitário da linha ${i + 1}`}
                    />
                    <span className="flex items-center justify-end px-2 text-[13px] font-medium">
                      {formatEur(computeLineTotal(Number(l.quantity), Number(l.unit_price)))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLinhas((a) => [...a, { ...LINHA_VAZIA }])}
              className="mt-2 flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{ borderColor: "var(--color-border)" }}
            >
              <Plus className="h-3.5 w-3.5" />
              Acrescentar linha
            </button>
          </div>

          {/* ── Totais ── */}
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="block text-[12.5px] font-medium">
                Desconto (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={discountPct}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  className="mt-1 w-24 rounded-lg border px-2 py-1.5 text-[13px]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-[12.5px] font-medium">
                <input type="checkbox" checked={applyVat} onChange={(e) => setApplyVat(e.target.checked)} />
                Aplicar IVA ({vatRate}%)
              </label>
            </div>

            <dl className="mt-3 space-y-1 text-[13px]">
              <div className="flex justify-between">
                <dt style={{ color: "var(--color-text-muted)" }}>Subtotal</dt>
                <dd>{formatEur(totais.subtotal)}</dd>
              </div>
              {Number(discountPct) > 0 && (
                <div className="flex justify-between">
                  <dt style={{ color: "var(--color-text-muted)" }}>Depois do desconto</dt>
                  <dd>{formatEur(totais.base)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt style={{ color: "var(--color-text-muted)" }}>IVA</dt>
                <dd>{formatEur(totais.vatAmount)}</dd>
              </div>
              <div
                className="flex justify-between border-t pt-1.5 text-[15px] font-semibold"
                style={{ borderColor: "var(--color-border)", color: "#16A34A" }}
              >
                <dt>Total</dt>
                <dd>{formatEur(totais.total)}</dd>
              </div>
            </dl>
          </div>

          <label className="block text-[12.5px] font-medium">
            Periodicidade proposta
            <input
              value={proposedFrequency}
              onChange={(e) => setProposedFrequency(e.target.value)}
              placeholder="2x por semana, quinzenal…"
              className={CAMPO}
            />
          </label>

          <label className="block text-[12.5px] font-medium">
            Condições de pagamento
            <input
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              placeholder="30 dias, pronto pagamento…"
              className={CAMPO}
            />
          </label>

          <label className="block text-[12.5px] font-medium">
            Observações <span className="font-normal" style={{ color: "var(--color-text-muted)" }}>(saem no PDF)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={5000} className={CAMPO} />
          </label>

          <label className="block text-[12.5px] font-medium">
            Notas internas
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Só para a equipa"
              className={CAMPO}
            />
            <span className="mt-0.5 block text-[11.5px] font-normal" style={{ color: "var(--color-text-muted)" }}>
              Nunca aparecem no PDF nem no email.
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={pending || !leadId}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {pending ? "A criar…" : "Criar orçamento"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
