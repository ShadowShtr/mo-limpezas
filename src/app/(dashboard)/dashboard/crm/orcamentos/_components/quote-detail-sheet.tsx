"use client";

// ============================================================================
// O detalhe de um orçamento
// ============================================================================
//
// O que se faz aqui: ver, descarregar o PDF, mudar o estado e pedir uma
// revisão. O que NÃO se faz: reescrever o documento. Um orçamento gravado é o
// que foi dito ao cliente, e altera-se criando uma versão nova — nunca em
// cima da antiga.
//
// 🔴 Os valores mostrados são os PERSISTIDOS. Não há recálculo nenhum neste
//    ficheiro: se o ecrã e a base discordassem sobre um total, o ecrã estaria
//    a mentir sobre um documento que já saiu.
//
// 🔴 As transições oferecidas vêm de `QUOTE_TRANSITIONS`, que é espelho da
//    matriz de `set_crm_quote_status` — e a decisão continua a ser da base,
//    sob `FOR UPDATE`. Esta lista serve para não oferecer botões que dariam
//    erro; não serve como autorização.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Download, FileClock, TriangleAlert, UserPlus, X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fmtLisbon } from "@/lib/lisbon-time";
import {
  allowedQuoteTransitions,
  canConvertQuote,
  canReviseQuote,
  isConvertedLeadQuote,
  isQuoteStatus,
  QUOTE_STATUS_LABELS,
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_UNIT_LABELS,
  type QuotePricingKind,
  type QuoteStatus,
  type QuoteUnit,
} from "@/lib/crm/quotes";
import {
  getQuote,
  setQuoteStatus,
  type QuoteRow,
  type QuoteWithItems,
} from "@/app/actions/crm-orcamentos";
import { convertAcceptedQuote } from "@/app/actions/crm-conversao";

import { downloadQuotePdf } from "./quote-pdf";

interface Props {
  orcamento: QuoteRow;
  empresaNome: string;
  onClose: () => void;
  /** Mudou o estado ou nasceu uma revisão: a lista tem de recarregar. */
  onChanged: () => void;
  onRevise: (base: QuoteWithItems) => void;
}

const fmtEur = (v: number): string =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

const fmtDate = (iso: string): string =>
  new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeZone: "Europe/Lisbon" })
    .format(new Date(`${iso}T12:00:00Z`));

/** O verbo de cada transição, do ponto de vista de quem carrega no botão. */
const ACCAO: Record<QuoteStatus, string> = {
  rascunho: "Voltar a rascunho",
  enviado: "Marcar como enviado",
  aceite: "Marcar como aceite",
  recusado: "Marcar como recusado",
  expirado: "Marcar como expirado",
  anulado: "Anular",
};

export function QuoteDetailSheet({
  orcamento,
  empresaNome,
  onClose,
  onChanged,
  onRevise,
}: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /**
   * 🔴 Estado PRÓPRIO para a conversão, e não `startTransition`.
   *
   *    `ConfirmDialog` faz `await onConfirm()` e fecha-se a seguir. Se o
   *    `onConfirm` fosse `() => startTransition(async () => { … })`, o
   *    `startTransition` devolveria `void` — o `await` resolvia de imediato e
   *    o diálogo fechava ANTES de a conversão terminar, dando a impressão de
   *    que já estava feita. Com uma Promise verdadeira, o diálogo espera.
   */
  const [converting, setConverting] = useState(false);

  /**
   * 🔴 `busy` cobre QUALQUER escrita em curso, não só a conversão, e é
   *    declarado ANTES dos `useEffect` que o usam — uma `const` referida numa
   *    lista de dependências acima da própria declaração rebenta em TDZ.
   *
   *    Fechar o painel a meio de uma conversão não a cancela — ela continua no
   *    servidor —, mas tira o ecrã a quem a lançou e faz perder o resultado. A
   *    pessoa fica sem saber se o cliente foi criado, e a tentação seguinte é
   *    clicar outra vez.
   */
  const busy = pending || converting;

  const [dados, setDados] = useState<QuoteWithItems | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aRecusar, setARecusar] = useState(false);
  const [motivo, setMotivo] = useState("");

  // As linhas não viajam na lista — seriam N× mais dados para mostrar cinco
  // colunas. Carregam-se ao abrir o detalhe, que é quando alguém as quer ver.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const res = await getQuote(orcamento.id);
      if (!vivo) return;
      if (res.ok) setDados(res.data);
      else setErro(res.error.message);
    })();
    return () => {
      vivo = false;
    };
  }, [orcamento.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const q = dados?.quote ?? orcamento;
  const estado: QuoteStatus | null = isQuoteStatus(q.status) ? q.status : null;
  const substituido = q.superseded_by_id !== null;

  // 🔴 Um orçamento substituído não muda de estado — a RPC responde
  //    `QUOTE_ALREADY_SUPERSEDED`. Por isso a lista de destinos fica vazia:
  //    é a versão viva que se mexe, não esta.
  const destinos = estado && !substituido ? allowedQuoteTransitions(estado) : [];

  /**
   * A conversão.
   *
   * 🔴 `async` de verdade: `ConfirmDialog` faz `await onConfirm()` e só fecha
   *    quando esta Promise resolver. É isso que impede o diálogo de se fechar
   *    antes de haver resposta.
   */
  async function converter() {
    setConverting(true);
    try {
      const res = await convertAcceptedQuote(q.id);

      if (!res.ok) {
        // O `ConfirmDialog` fecha-se de qualquer forma (fá-lo no `finally`).
        // Fica-se no detalhe, com o toast — e sem navegar para lado nenhum.
        toast(res.error.message, "error");
        return;
      }

      toast(
        res.data.alreadyConverted
          ? "A lead já estava convertida. A abrir o cliente existente."
          : "Lead convertida em cliente.",
        "success",
      );

      // A invalidação já foi feita no servidor; não é preciso `router.refresh`.
      onClose();
      router.push(`/dashboard/clientes/${res.data.clientId}`);
    } finally {
      setConverting(false);
    }
  }

  function mudarEstado(destino: QuoteStatus, razao?: string) {
    startTransition(async () => {
      const res = await setQuoteStatus(q.id, { status: destino, reason: razao ?? null });
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      toast(`Orçamento ${QUOTE_STATUS_LABELS[res.data.status].toLowerCase()}.`, "success");
      setARecusar(false);
      setMotivo("");
      onChanged();
    });
  }

  async function descarregar() {
    if (!dados) return;
    try {
      // 🔴 Dados PERSISTIDOS, tal como vieram da base.
      await downloadQuotePdf({ quote: dados.quote, items: dados.items, empresaNome });
    } catch (err) {
      console.error("[quote-pdf] falhou:", err);
      toast("Não foi possível gerar o PDF.", "error");
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-detalhe-orcamento"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2 id="titulo-detalhe-orcamento" className="text-[15px] font-semibold">
              {q.quote_number}
            </h2>
            <p className="text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
              {q.target_name}
              {q.revision > 0 && ` · revisão R${q.revision}`}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Fechar" className="rounded-lg p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {erro && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
              <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
              {erro}
            </div>
          )}

          {substituido && (
            <div
              className="rounded-lg border px-3 py-2 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
            >
              <FileClock className="mr-1 inline h-3.5 w-3.5" />
              Versão histórica: foi substituída por uma revisão mais recente. Fica como registo do
              que foi dito, e já não se altera.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Estado
              </span>
              {estado ? QUOTE_STATUS_LABELS[estado] : q.status}
            </div>
            <div>
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Tipo
              </span>
              {QUOTE_PRICING_KIND_LABELS[q.pricing_kind as QuotePricingKind] ?? q.pricing_kind}
            </div>
            <div>
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Emitido
              </span>
              {fmtDate(q.issue_date)}
            </div>
            <div>
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Válido até
              </span>
              {fmtDate(q.valid_until)}
            </div>
            {q.sent_at && (
              <div>
                <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                  Enviado
                </span>
                {/*
                  🔴 `fmtLisbon`, e não `sent_at.slice(0, 10)`.
                     `sent_at` é um instante em UTC. Fatiar os dez primeiros
                     caracteres lê o dia EM UTC: um envio às 00:30 de Lisboa no
                     verão está gravado como 23:30 do dia anterior, e o ecrã
                     mostrava a véspera. É o mesmo defeito de fuso que a
                     auditoria de 2026-07-06 varreu do resto da aplicação.
                */}
                {fmtLisbon(q.sent_at, { dateStyle: "medium" })}
              </div>
            )}
            {q.rejection_reason && (
              <div className="col-span-2">
                <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                  Motivo da recusa
                </span>
                {q.rejection_reason}
              </div>
            )}
          </div>

          {/* ── As linhas gravadas ─────────────────────────────────────── */}
          <div
            className="overflow-hidden rounded-lg border"
            style={{ borderColor: "var(--color-border)" }}
          >
            {dados === null && !erro ? (
              <p className="p-4 text-center text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
                A carregar as linhas…
              </p>
            ) : (
              <table className="w-full text-left text-[12.5px]">
                <thead
                  className="border-b text-[11px] uppercase tracking-wide"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                >
                  <tr>
                    <th className="px-3 py-2 font-medium">Descrição</th>
                    <th className="px-3 py-2 text-right font-medium">Qtd.</th>
                    <th className="px-3 py-2 font-medium">Un.</th>
                    <th className="px-3 py-2 text-right font-medium">Preço</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(dados?.items ?? []).map((i) => (
                    <tr
                      key={i.id}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <td className="px-3 py-2">{i.description}</td>
                      <td className="px-3 py-2 text-right">{i.quantity}</td>
                      <td className="px-3 py-2">
                        {QUOTE_UNIT_LABELS[i.unit as QuoteUnit] ?? i.unit}
                      </td>
                      <td className="px-3 py-2 text-right">{fmtEur(i.unit_price)}</td>
                      <td className="px-3 py-2 text-right">{fmtEur(i.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Os totais, como estão gravados ─────────────────────────── */}
          <div className="space-y-1 text-[13px]">
            <div className="flex justify-between">
              <span style={{ color: "var(--color-text-muted)" }}>Subtotal</span>
              <span>{fmtEur(q.subtotal)}</span>
            </div>
            {q.discount_pct > 0 && (
              <div className="flex justify-between">
                <span style={{ color: "var(--color-text-muted)" }}>Desconto</span>
                <span>{q.discount_pct}%</span>
              </div>
            )}
            <div className="flex justify-between">
              <span style={{ color: "var(--color-text-muted)" }}>
                {q.apply_vat && q.vat_amount > 0 ? `IVA (${q.vat_rate}%)` : "IVA"}
              </span>
              <span>{q.apply_vat && q.vat_amount > 0 ? fmtEur(q.vat_amount) : "Isento"}</span>
            </div>
            <div
              className="flex justify-between border-t pt-1 font-semibold"
              style={{ borderColor: "var(--color-border)" }}
            >
              <span>Total</span>
              <span style={{ color: "#16A34A" }}>{fmtEur(q.total)}</span>
            </div>
          </div>

          {q.payment_terms && (
            <div className="text-[12.5px]">
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Condições de pagamento
              </span>
              {q.payment_terms}
            </div>
          )}

          {q.notes && (
            <div className="text-[12.5px]">
              <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Observações (saem no PDF)
              </span>
              <p className="whitespace-pre-line">{q.notes}</p>
            </div>
          )}

          {/*
            🔴 Notas internas. Só aqui — a RLS de `crm_quotes` não deixa outro
               papel além de admin/gestor ler a tabela, e o PDF não as recebe.
          */}
          {q.internal_notes && (
            <div
              className="rounded-lg border px-3 py-2 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
            >
              <span className="block text-[11.5px] font-medium">
                Notas internas — não saem no PDF
              </span>
              <p className="mt-0.5 whitespace-pre-line">{q.internal_notes}</p>
            </div>
          )}

          {/* ── Recusar pede motivo ────────────────────────────────────── */}
          {aRecusar && (
            <div
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <label className="block text-[12.5px] font-medium">
                Porque é que foi recusado?
                <textarea
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  rows={2}
                  maxLength={500}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </label>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setARecusar(false);
                    setMotivo("");
                  }}
                  disabled={busy}
                  className="rounded-lg border px-2.5 py-1 text-[12.5px] font-medium"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  Cancelar
                </button>
                <button
                  onClick={() => mudarEstado("recusado", motivo || undefined)}
                  disabled={busy}
                  className="rounded-lg px-2.5 py-1 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: "#B91C1C" }}
                >
                  Registar recusa
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="flex flex-wrap items-center gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            onClick={descarregar}
            disabled={!dados || busy}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Download className="h-4 w-4" />
            PDF
          </button>

          {canReviseQuote(q) && (
            <button
              onClick={() => dados && onRevise(dados)}
              disabled={!dados || busy}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
              style={{ borderColor: "var(--color-border)" }}
            >
              <FileClock className="h-4 w-4" />
              Criar revisão
            </button>
          )}

          {/*
            🔴 Os dois estados são MUTUAMENTE EXCLUSIVOS, e é por isso que há
               duas funções em `lib/crm/quotes.ts` em vez de uma expressão
               repetida: `canConvertQuote` exige `client_id` nulo,
               `isConvertedLeadQuote` exige-o preenchido.

            🔴 E são ESPELHO DE UX. Quem decide é a RPC, sob lock: entre o que
               este ecrã mostrou e o clique cabe uma revisão feita por outra
               pessoa. O botão serve para não oferecer o que a base recusaria.
          */}
          {canConvertQuote(q) && (
            <ConfirmDialog
              trigger={
                <button
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  style={{ background: "#16A34A" }}
                >
                  <UserPlus className="h-4 w-4" />
                  {converting ? "A converter…" : "Converter em cliente"}
                </button>
              }
              title="Converter esta lead em cliente?"
              description="Vai criar um cliente e um local com os dados da lead e marcar a lead como ganha. O orçamento mantém-se aceite. Não cria contrato nem agenda serviços — isso faz-se depois na ficha do cliente."
              confirmLabel="Converter em cliente"
              variant="default"
              onConfirm={converter}
            />
          )}

          {isConvertedLeadQuote(q) && q.client_id && (
            <a
              href={`/dashboard/clientes/${q.client_id}`}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium"
              style={{ borderColor: "var(--color-border)" }}
            >
              <UserPlus className="h-4 w-4" />
              Abrir cliente
            </a>
          )}

          <div className="ml-auto flex flex-wrap gap-2">
            {destinos.map((destino) => (
              <button
                key={destino}
                onClick={() => {
                  // A recusa leva motivo, e o motivo pede-se antes de gravar.
                  if (destino === "recusado") setARecusar(true);
                  else mudarEstado(destino);
                }}
                disabled={busy}
                className="rounded-lg px-3 py-2 text-[13px] font-semibold disabled:opacity-50"
                style={
                  destino === "enviado" || destino === "aceite"
                    ? { background: "#16A34A", color: "#fff" }
                    : { border: "1px solid var(--color-border)" }
                }
              >
                {ACCAO[destino]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
