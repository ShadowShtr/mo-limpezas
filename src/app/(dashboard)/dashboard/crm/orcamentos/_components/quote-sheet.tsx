"use client";

// ============================================================================
// Criar um orçamento — e revê-lo
// ============================================================================
//
// 🔴 UM componente para os dois fluxos, e não por economia de ficheiros: o
//    formulário de revisão TEM de mostrar exactamente os mesmos campos de
//    dinheiro que a criação mostrou, com as linhas da versão anterior já
//    dentro. Dois formulários separados divergiriam no primeiro campo novo, e
//    a divergência apareceria num documento que vai para um cliente.
//
//    `base` presente = revisão. Ausente = criação.
//
// ---------------------------------------------------------------------------
// 🔴 O que muda entre os dois, e porquê
// ---------------------------------------------------------------------------
//
//   · o DESTINATÁRIO não se escolhe numa revisão. `revise_crm_quote` copia
//     `lead_id`, `client_id`, `source_lead_id` e `visit_id` da versão
//     anterior — a proveniência é imutável por trigger. Oferecer o selector
//     seria oferecer uma escolha que a base ignora;
//
//   · o TIPO (pontual/mensal), as condições de pagamento e os dias propostos
//     também são herdados pela RPC. Mesma razão;
//
//   · as NOTAS INTERNAS não aparecem na revisão: a RPC herda-as
//     (`v_antiga.internal_notes`) e não aceita um valor novo. Um campo
//     editável cujo conteúdo é descartado em silêncio é pior do que a
//     ausência do campo.
//
// 🔴 Os totais mostrados aqui são PRÉ-VISUALIZAÇÃO, e dizem-no no ecrã. Os
//    valores que valem são os que a RPC grava — `totaisDoOrcamento` existe
//    para os antecipar com a mesma aritmética, e há um ensaio de paridade
//    contra Postgres real a garantir que continuam a coincidir.
// ============================================================================

import { useEffect, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { addDaysToDateString, todayInLisbon } from "@/lib/lisbon-time";
import {
  QUOTE_DEFAULT_VALIDITY_DAYS,
  QUOTE_PRICING_KINDS,
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_UNITS,
  QUOTE_UNIT_LABELS,
  totaisDoOrcamento,
  type QuotePricingKind,
  type QuoteUnit,
} from "@/lib/crm/quotes";
import { createQuote, reviseQuote, type QuoteWithItems } from "@/app/actions/crm-orcamentos";
import type { VisitRow } from "@/app/actions/crm-visitas";
import type { LeadRow } from "@/app/actions/crm-leads";

const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

export interface ClienteOpcao {
  id: string;
  name: string;
}

interface Props {
  leads: LeadRow[];
  clientes: ClienteOpcao[];
  visitas: VisitRow[];
  /** Só para a pré-visualização. Nulo quando as definições não carregaram. */
  vatRate: number | null;
  /** Presente = revisão de um orçamento que já saiu. */
  base?: QuoteWithItems;
  onClose: () => void;
  onDone: (numero: string) => void;
}

/** O orçamento é para uma lead ou para um cliente. Nunca os dois, nunca nenhum. */
type AlvoTipo = "lead" | "cliente";

interface LinhaForm {
  description: string;
  quantity: string;
  unit: QuoteUnit;
  unitPrice: string;
}

const LINHA_VAZIA: LinhaForm = { description: "", quantity: "1", unit: "servico", unitPrice: "" };

const fmtEur = (v: number): string =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

export function QuoteSheet({
  leads,
  clientes,
  visitas,
  vatRate,
  base,
  onClose,
  onDone,
}: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [erros, setErros] = useState<Record<string, string[]>>({});

  const eRevisao = Boolean(base);
  const hoje = todayInLisbon();

  const [alvoTipo, setAlvoTipo] = useState<AlvoTipo>("lead");
  const [leadId, setLeadId] = useState("");
  const [clientId, setClientId] = useState("");
  const [visitId, setVisitId] = useState("");

  const [issueDate, setIssueDate] = useState(base?.quote.issue_date ?? hoje);
  const [validUntil, setValidUntil] = useState(
    addDaysToDateString(base?.quote.issue_date ?? hoje, QUOTE_DEFAULT_VALIDITY_DAYS),
  );
  const [pricingKind, setPricingKind] = useState<QuotePricingKind>("pontual");
  const [discountPct, setDiscountPct] = useState(
    base ? String(base.quote.discount_pct) : "0",
  );
  const [applyVat, setApplyVat] = useState(base?.quote.apply_vat ?? true);
  const [proposedFrequency, setProposedFrequency] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState(base?.quote.notes ?? "");
  const [internalNotes, setInternalNotes] = useState("");

  const [linhas, setLinhas] = useState<LinhaForm[]>(() =>
    base
      ? base.items.map((i) => ({
          description: i.description,
          quantity: String(i.quantity),
          unit: (QUOTE_UNITS as readonly string[]).includes(i.unit)
            ? (i.unit as QuoteUnit)
            : "servico",
          unitPrice: String(i.unit_price),
        }))
      : [{ ...LINHA_VAZIA }],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  /** Trocar de tipo limpa o outro lado — e a visita, que era do outro alvo. */
  function escolherTipo(tipo: AlvoTipo) {
    setAlvoTipo(tipo);
    setVisitId("");
    if (tipo === "lead") setClientId("");
    else setLeadId("");
  }

  /**
   * As visitas que este destinatário pode usar.
   *
   * 🔴 O filtro não é cosmético: `create_crm_quote_with_items` verifica que a
   *    visita pertence ao destinatário e recusa com `QUOTE_VISIT_MISMATCH`.
   *    Mostrar só as compatíveis evita oferecer uma escolha que a base rejeita.
   */
  const visitasDoAlvo = useMemo(() => {
    const alvo = alvoTipo === "lead" ? leadId : clientId;
    if (!alvo) return [];
    return visitas.filter((v) => (alvoTipo === "lead" ? v.lead_id === alvo : v.client_id === alvo));
  }, [alvoTipo, leadId, clientId, visitas]);

  const itensNumericos = useMemo(
    () =>
      linhas.map((l) => ({
        quantity: Number(l.quantity.replace(",", ".")) || 0,
        unit_price: Number(l.unitPrice.replace(",", ".")) || 0,
      })),
    [linhas],
  );

  const previsao = useMemo(
    () =>
      totaisDoOrcamento(itensNumericos, {
        discountPct: Number(discountPct.replace(",", ".")) || 0,
        applyVat,
        vatRate,
      }),
    [itensNumericos, discountPct, applyVat, vatRate],
  );

  function alterarLinha(i: number, patch: Partial<LinhaForm>) {
    setLinhas((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function removerLinha(i: number) {
    // Nunca zero linhas: a base recusa um orçamento sem linhas, e com razão —
    // «um documento a zero que parece emitido».
    setLinhas((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  /** Ignora datas malformadas do input nativo (o ano com um dígito a mais). */
  function guardarData(valor: string, set: (v: string) => void) {
    if (valor === "" || /^\d{4}-\d{2}-\d{2}$/.test(valor)) set(valor);
  }

  const alvoEscolhido = alvoTipo === "lead" ? leadId : clientId;

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErros({});

    const items = linhas.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity.replace(",", ".")),
      unit: l.unit,
      unitPrice: Number(l.unitPrice.replace(",", ".")),
    }));

    startTransition(async () => {
      const res = base
        ? await reviseQuote(base.quote.id, {
            issueDate,
            validUntil,
            discountPct: Number(discountPct.replace(",", ".")) || 0,
            applyVat,
            notes: notes || null,
            items,
          })
        : await createQuote({
            leadId: alvoTipo === "lead" ? leadId : null,
            clientId: alvoTipo === "cliente" ? clientId : null,
            visitId: visitId || null,
            issueDate,
            validUntil,
            pricingKind,
            discountPct: Number(discountPct.replace(",", ".")) || 0,
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
      onDone(res.data.quoteNumber);
    });
  }

  const titulo = eRevisao
    ? `Revisão de ${base?.quote.quote_number}`
    : "Novo orçamento";

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
          <h2 id="titulo-orcamento" className="text-[15px] font-semibold">{titulo}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Fechar"
            className="rounded-lg p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {eRevisao ? (
            <p
              className="rounded-lg border px-3 py-2 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
            >
              A revisão cria um documento novo — <strong>R{(base?.quote.revision ?? 0) + 1}</strong>,
              em rascunho — para <strong>{base?.quote.target_name}</strong>. O{" "}
              {base?.quote.quote_number} fica no histórico, marcado como substituído, e não se
              altera.
            </p>
          ) : (
            <>
              <fieldset>
                <legend className="text-[12.5px] font-medium">Para quem</legend>
                <div className="mt-2 flex gap-4">
                  {([
                    ["lead", "Uma lead"],
                    ["cliente", "Um cliente"],
                  ] as const).map(([valor, etiqueta]) => (
                    <label key={valor} className="flex items-center gap-2 text-[13px] font-normal">
                      <input
                        type="radio"
                        name="alvo-orcamento"
                        value={valor}
                        checked={alvoTipo === valor}
                        onChange={() => escolherTipo(valor)}
                      />
                      {etiqueta}
                    </label>
                  ))}
                </div>
              </fieldset>

              {alvoTipo === "lead" ? (
                <label className="block text-[12.5px] font-medium">
                  Lead<span className="ml-0.5 text-red-500">*</span>
                  <select
                    value={leadId}
                    onChange={(e) => {
                      setLeadId(e.target.value);
                      setVisitId("");
                    }}
                    required
                    className={CAMPO}
                  >
                    <option value="">Escolha a lead…</option>
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                  {erros.leadId?.[0] && (
                    <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                      {erros.leadId[0]}
                    </span>
                  )}
                </label>
              ) : (
                <label className="block text-[12.5px] font-medium">
                  Cliente<span className="ml-0.5 text-red-500">*</span>
                  <select
                    value={clientId}
                    onChange={(e) => {
                      setClientId(e.target.value);
                      setVisitId("");
                    }}
                    required
                    className={CAMPO}
                  >
                    <option value="">Escolha o cliente…</option>
                    {clientes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {erros.clientId?.[0] && (
                    <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                      {erros.clientId[0]}
                    </span>
                  )}
                </label>
              )}

              <label className="block text-[12.5px] font-medium">
                Visita de onde saíram as medidas
                <select
                  value={visitId}
                  onChange={(e) => setVisitId(e.target.value)}
                  disabled={!alvoEscolhido}
                  className={CAMPO}
                >
                  <option value="">Sem visita</option>
                  {visitasDoAlvo.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.scheduled_start.slice(0, 10)} — {v.status}
                      {v.area_sqm != null ? ` (${v.area_sqm} m²)` : ""}
                    </option>
                  ))}
                </select>
                <span
                  className="mt-0.5 block text-[11.5px] font-normal"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {alvoEscolhido
                    ? "Opcional. Só aparecem visitas deste destinatário."
                    : "Escolha primeiro o destinatário."}
                </span>
              </label>

              <label className="block text-[12.5px] font-medium">
                Tipo
                <select
                  value={pricingKind}
                  onChange={(e) => setPricingKind(e.target.value as QuotePricingKind)}
                  className={CAMPO}
                >
                  {QUOTE_PRICING_KINDS.map((k) => (
                    <option key={k} value={k}>{QUOTE_PRICING_KIND_LABELS[k]}</option>
                  ))}
                </select>
              </label>

              {pricingKind === "mensal" && (
                <label className="block text-[12.5px] font-medium">
                  Frequência proposta
                  <input
                    type="text"
                    value={proposedFrequency}
                    onChange={(e) => setProposedFrequency(e.target.value)}
                    placeholder="ex.: 3× por semana"
                    maxLength={50}
                    className={CAMPO}
                  />
                  <span
                    className="mt-0.5 block text-[11.5px] font-normal"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    Fica registada para quando o orçamento der origem a um contrato.
                  </span>
                </label>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12.5px] font-medium">
              Data de emissão
              <input
                type="date"
                value={issueDate}
                onChange={(e) => guardarData(e.target.value, setIssueDate)}
                required
                className={CAMPO}
              />
            </label>
            <label className="block text-[12.5px] font-medium">
              Válido até
              <input
                type="date"
                value={validUntil}
                onChange={(e) => guardarData(e.target.value, setValidUntil)}
                required
                className={CAMPO}
              />
              {erros.validUntil?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                  {erros.validUntil[0]}
                </span>
              )}
            </label>
          </div>

          {/* ── As linhas ──────────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium">Linhas</span>
              <button
                type="button"
                onClick={() => setLinhas((prev) => [...prev, { ...LINHA_VAZIA }])}
                className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[12.5px] font-medium"
                style={{ borderColor: "var(--color-border)" }}
              >
                <Plus className="h-3.5 w-3.5" />
                Linha
              </button>
            </div>

            <div className="mt-2 space-y-2">
              {linhas.map((l, i) => (
                <div key={i} className="grid grid-cols-12 items-start gap-2">
                  <input
                    type="text"
                    value={l.description}
                    onChange={(e) => alterarLinha(i, { description: e.target.value })}
                    placeholder="Descrição"
                    required
                    maxLength={500}
                    aria-label={`Descrição da linha ${i + 1}`}
                    className={`${CAMPO} col-span-5 mt-0`}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => alterarLinha(i, { quantity: e.target.value })}
                    placeholder="Qtd."
                    required
                    aria-label={`Quantidade da linha ${i + 1}`}
                    className={`${CAMPO} col-span-2 mt-0 text-right`}
                  />
                  <select
                    value={l.unit}
                    onChange={(e) => alterarLinha(i, { unit: e.target.value as QuoteUnit })}
                    aria-label={`Unidade da linha ${i + 1}`}
                    className={`${CAMPO} col-span-2 mt-0`}
                  >
                    {QUOTE_UNITS.map((u) => (
                      <option key={u} value={u}>{QUOTE_UNIT_LABELS[u]}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) => alterarLinha(i, { unitPrice: e.target.value })}
                    placeholder="€"
                    required
                    aria-label={`Preço unitário da linha ${i + 1}`}
                    className={`${CAMPO} col-span-2 mt-0 text-right`}
                  />
                  <button
                    type="button"
                    onClick={() => removerLinha(i)}
                    disabled={linhas.length === 1}
                    aria-label={`Remover linha ${i + 1}`}
                    className="col-span-1 mt-2 justify-self-center disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" style={{ color: "var(--color-text-muted)" }} />
                  </button>
                </div>
              ))}
            </div>

            {erros.items?.[0] && (
              <p className="mt-1 text-[11.5px] text-red-600">{erros.items[0]}</p>
            )}
          </div>

          {/* ── Dinheiro ───────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12.5px] font-medium">
              Desconto (%)
              <input
                type="text"
                inputMode="decimal"
                value={discountPct}
                onChange={(e) => setDiscountPct(e.target.value)}
                className={CAMPO}
              />
              {erros.discountPct?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                  {erros.discountPct[0]}
                </span>
              )}
            </label>
            <label className="mt-6 flex items-center gap-2 text-[13px] font-normal">
              <input
                type="checkbox"
                checked={applyVat}
                onChange={(e) => setApplyVat(e.target.checked)}
              />
              Aplicar IVA{vatRate != null ? ` (${vatRate}%)` : ""}
            </label>
          </div>

          <div
            className="rounded-lg border px-3 py-2 text-[13px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
          >
            <div className="flex justify-between">
              <span style={{ color: "var(--color-text-muted)" }}>Subtotal</span>
              <span>{fmtEur(previsao.subtotal)}</span>
            </div>
            {previsao.base !== previsao.subtotal && (
              <div className="flex justify-between">
                <span style={{ color: "var(--color-text-muted)" }}>Depois do desconto</span>
                <span>{fmtEur(previsao.base)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span style={{ color: "var(--color-text-muted)" }}>IVA</span>
              <span>{fmtEur(previsao.vatAmount)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold"
              style={{ borderColor: "var(--color-border)" }}
            >
              <span>Total</span>
              <span style={{ color: "#16A34A" }}>{fmtEur(previsao.total)}</span>
            </div>
            <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
              {/*
                🔴 Dizer isto em voz alta, no ecrã. Os valores definitivos são
                   os que o servidor calcula e grava — com a taxa de IVA que
                   ELE lê das definições no momento de gravar.
              */}
              Pré-visualização. Os valores do documento são os que o servidor gravar.
              {vatRate == null && " A taxa de IVA das definições não carregou."}
            </p>
          </div>

          <label className="block text-[12.5px] font-medium">
            Observações para o cliente
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={5000}
              className={CAMPO}
            />
            <span
              className="mt-0.5 block text-[11.5px] font-normal"
              style={{ color: "var(--color-text-muted)" }}
            >
              Saem no PDF.
            </span>
          </label>

          {!eRevisao && (
            <>
              <label className="block text-[12.5px] font-medium">
                Condições de pagamento
                <input
                  type="text"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  placeholder="ex.: 30 dias após a fatura"
                  maxLength={500}
                  className={CAMPO}
                />
              </label>

              <label className="block text-[12.5px] font-medium">
                Notas internas
                <textarea
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  rows={2}
                  maxLength={5000}
                  className={CAMPO}
                />
                <span
                  className="mt-0.5 block text-[11.5px] font-normal"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {/*
                    🔴 A promessa é verificada por teste: `quote-pdf.ts` não
                       recebe nem escreve `internal_notes`.
                  */}
                  Nunca saem no PDF nem vão para o cliente.
                </span>
              </label>
            </>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
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
            disabled={pending || (!eRevisao && !alvoEscolhido)}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {pending ? "A guardar…" : eRevisao ? "Criar revisão" : "Criar orçamento"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
