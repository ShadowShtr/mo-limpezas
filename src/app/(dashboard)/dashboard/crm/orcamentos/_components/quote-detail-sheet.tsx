"use client";

// ============================================================================
// A ficha do orçamento — ver, enviar, decidir
// ============================================================================
//
// O PDF é construído aqui, no browser, e o MESMO ficheiro vai para o disco e
// para o anexo do email. Gerá-lo duas vezes abriria a hipótese de enviar um
// documento diferente do que o gestor reviu antes de carregar em enviar.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Download, Mail, UserPlus, X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatEur } from "@/domain/crm/quote-totals";
import {
  QUOTE_STATUS_LABELS,
  QUOTE_UNIT_LABELS,
  allowedQuoteTransitions,
  isExpired,
  isQuoteStatus,
  isRevisable,
  type QuoteStatus,
  type QuoteUnit,
} from "@/lib/crm/quotes";
import { sendQuoteByEmail, setQuoteStatus, type QuoteRow } from "@/app/actions/crm-orcamentos";
import { converterLeadEmCliente } from "@/app/actions/crm-conversao";

import { buildQuotePdf, downloadQuotePdf } from "./quote-pdf";

interface Props {
  quote: QuoteRow;
  hoje: string;
  onClose: () => void;
  onChanged: () => void;
}

function fmtData(iso: string | null): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

/** `Blob` → base64, sem o prefixo `data:`. */
function blobParaBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result);
      const virgula = r.indexOf(",");
      resolve(virgula === -1 ? r : r.slice(virgula + 1));
    };
    reader.onerror = () => reject(new Error("Não foi possível ler o PDF."));
    reader.readAsDataURL(blob);
  });
}

export function QuoteDetailSheet({ quote, hoje, onClose, onChanged }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [aEnviar, setAEnviar] = useState(false);
  const [destino, setDestino] = useState("");
  const [mensagem, setMensagem] = useState("");

  const estado = isQuoteStatus(quote.status) ? quote.status : null;
  const expirado = estado ? isExpired(estado, quote.valid_until, hoje) : false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  function verPdf() {
    startTransition(async () => {
      try {
        await downloadQuotePdf(quote);
      } catch {
        // O import dinâmico do jspdf pode falhar sem rede; o erro nativo não
        // diz nada a quem está no ecrã.
        toast("Não foi possível gerar o PDF.", "error");
      }
    });
  }

  function enviar() {
    if (!destino.trim()) {
      toast("Indique o email para onde enviar.", "error");
      return;
    }

    startTransition(async () => {
      let pdfBase64: string;
      try {
        // O PDF é gerado primeiro: se falhar, nada é enviado e o estado não
        // muda. O contrário — marcar como enviado e depois falhar o PDF —
        // deixaria um orçamento "enviado" que ninguém recebeu.
        const blob = await buildQuotePdf(quote);
        pdfBase64 = await blobParaBase64(blob);
      } catch {
        toast("Não foi possível gerar o PDF para anexar.", "error");
        return;
      }

      const res = await sendQuoteByEmail(quote.id, {
        to: destino.trim(),
        customMessage: mensagem.trim() || null,
        pdfBase64,
      });

      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }

      toast(`Orçamento enviado para ${destino.trim()}.`, "success");
      onChanged();
    });
  }

  /**
   * Converte a lead em cliente e leva o gestor ao formulário já preenchido.
   *
   * 🔴 Nada é agendado aqui. O destino é um formulário com os campos postos —
   *    quem grava é uma pessoa, depois de rever.
   */
  function converter() {
    if (!quote.lead_id) return;

    startTransition(async () => {
      const res = await converterLeadEmCliente(quote.lead_id!, { quoteId: quote.id });
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      toast("Cliente criado. Reveja e confirme o que fica agendado.", "success");
      router.push(res.data.redirectTo);
    });
  }

  function mudarEstado(novo: QuoteStatus, motivo?: string) {
    startTransition(async () => {
      const res = await setQuoteStatus(quote.id, { status: novo, reason: motivo ?? null });
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      toast(`Orçamento marcado como ${QUOTE_STATUS_LABELS[novo].toLowerCase()}.`, "success");
      onChanged();
    });
  }

  const transicoes = estado ? allowedQuoteTransitions(estado) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-ficha-orcamento"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2 id="titulo-ficha-orcamento" className="text-[15px] font-semibold">
              {quote.quote_number}
            </h2>
            <p className="text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
              {quote.target_name} · {estado ? QUOTE_STATUS_LABELS[estado] : quote.status}
              {expirado && " · fora de validade"}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Fechar" className="rounded-lg p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {expirado && (
            <p className="rounded-lg bg-amber-50 p-3 text-[12.5px] text-amber-800">
              A validade deste orçamento passou a {fmtData(quote.valid_until)}. Para o dar
              como aceite, reveja-o primeiro com uma data nova — o preço de há
              dois meses pode já não estar de pé.
            </p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <div>
              <dt className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>Data</dt>
              <dd>{fmtData(quote.issue_date)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>Válido até</dt>
              <dd>{fmtData(quote.valid_until)}</dd>
            </div>
            {quote.sent_at && (
              <div>
                <dt className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>Enviado</dt>
                <dd>{fmtData(quote.sent_at.slice(0, 10))}</dd>
              </div>
            )}
            {quote.revision > 0 && (
              <div>
                <dt className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>Revisão</dt>
                <dd>R{quote.revision}</dd>
              </div>
            )}
          </dl>

          {/* ── Linhas ── */}
          <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
            <table className="w-full text-left text-[12.5px]">
              <thead
                className="border-b text-[11px] uppercase"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
              >
                <tr>
                  <th className="px-3 py-2 font-medium">Descrição</th>
                  <th className="px-3 py-2 text-right font-medium">Qtd.</th>
                  <th className="px-3 py-2 text-right font-medium">Preço</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {(quote.items ?? []).map((it) => (
                  <tr key={it.id} className="border-b last:border-0" style={{ borderColor: "var(--color-border)" }}>
                    <td className="px-3 py-2">{it.description}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {it.quantity} {QUOTE_UNIT_LABELS[it.unit as QuoteUnit] ?? it.unit}
                    </td>
                    <td className="px-3 py-2 text-right">{formatEur(Number(it.unit_price))}</td>
                    <td className="px-3 py-2 text-right">{formatEur(Number(it.line_total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="space-y-1 text-[13px]">
            <div className="flex justify-between">
              <dt style={{ color: "var(--color-text-muted)" }}>Subtotal</dt>
              <dd>{formatEur(Number(quote.subtotal))}</dd>
            </div>
            {Number(quote.discount_pct) > 0 && (
              <div className="flex justify-between">
                <dt style={{ color: "var(--color-text-muted)" }}>Desconto ({quote.discount_pct}%)</dt>
                <dd>−{formatEur(Number(quote.subtotal) - (Number(quote.total) - Number(quote.vat_amount)))}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt style={{ color: "var(--color-text-muted)" }}>
                IVA {quote.apply_vat ? `(${quote.vat_rate}%)` : "(isento)"}
              </dt>
              <dd>{formatEur(Number(quote.vat_amount))}</dd>
            </div>
            <div
              className="flex justify-between border-t pt-1.5 text-[15px] font-semibold"
              style={{ borderColor: "var(--color-border)", color: "#16A34A" }}
            >
              <dt>Total</dt>
              <dd>{formatEur(Number(quote.total))}</dd>
            </div>
          </dl>

          {quote.internal_notes && (
            <div className="rounded-lg bg-slate-50 p-3 text-[12.5px]">
              <p className="font-medium">Notas internas</p>
              <p className="mt-0.5 whitespace-pre-wrap" style={{ color: "var(--color-text-muted)" }}>
                {quote.internal_notes}
              </p>
              <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                Não saem no PDF nem no email.
              </p>
            </div>
          )}

          {/* ── Enviar ── */}
          {aEnviar && (
            <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
              <p className="text-[12.5px] font-medium">Enviar por email</p>
              <input
                type="email"
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                placeholder="email@cliente.pt"
                className="mt-2 w-full rounded-lg border px-3 py-2 text-[13px]"
                style={{ borderColor: "var(--color-border)" }}
                aria-label="Email de destino"
              />
              <textarea
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Mensagem (opcional) — substitui o texto padrão"
                className="mt-2 w-full rounded-lg border px-3 py-2 text-[13px]"
                style={{ borderColor: "var(--color-border)" }}
              />
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                O PDF vai em anexo, e o total e a validade também aparecem no
                corpo do email — muita gente lê no telemóvel e não abre o anexo.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={() => setAEnviar(false)}
                  disabled={pending}
                  className="rounded-lg border px-3 py-1.5 text-[12.5px] font-medium"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  Cancelar
                </button>
                <button
                  onClick={enviar}
                  disabled={pending || !destino.trim()}
                  className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: "#16A34A" }}
                >
                  {pending ? "A enviar…" : "Enviar"}
                </button>
              </div>
            </div>
          )}

          {estado && isRevisable(estado) && (
            <p className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
              Este orçamento já foi enviado. Alterá-lo cria uma revisão nova —
              o documento que o cliente recebeu não muda por baixo dele.
            </p>
          )}
        </div>

        <div
          className="flex flex-wrap justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          {estado === "aceite" && quote.lead_id && !quote.converted_contract_id && (
            <ConfirmDialog
              trigger={
                <button
                  disabled={pending}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  style={{ background: "#16A34A" }}
                >
                  <UserPlus className="h-4 w-4" />
                  Converter em cliente
                </button>
              }
              title="Converter esta lead em cliente?"
              description="Cria o cliente e o local com os dados da lead, e abre o formulário do trabalho já preenchido com os valores do orçamento. Nada fica agendado até confirmar."
              confirmLabel="Converter"
              onConfirm={converter}
            />
          )}

          <button
            onClick={verPdf}
            disabled={pending}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Download className="h-4 w-4" />
            PDF
          </button>

          {!aEnviar && estado !== "aceite" && estado !== "anulado" && (
            <button
              onClick={() => setAEnviar(true)}
              disabled={pending}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
              style={{ borderColor: "var(--color-border)" }}
            >
              <Mail className="h-4 w-4" />
              Enviar
            </button>
          )}

          {transicoes
            // "enviado" tem botão próprio, com o email. Oferecê-lo aqui
            // deixaria marcar como enviado sem nada ter sido enviado.
            .filter((t) => t !== "enviado")
            .map((t) => (
              <ConfirmDialog
                key={t}
                trigger={
                  <button
                    disabled={pending}
                    className="rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
                    style={{
                      borderColor: t === "aceite" ? "#16A34A" : "var(--color-border)",
                      color: t === "aceite" ? "#16A34A" : undefined,
                    }}
                  >
                    {QUOTE_STATUS_LABELS[t]}
                  </button>
                }
                title={`Marcar como ${QUOTE_STATUS_LABELS[t].toLowerCase()}?`}
                description={
                  t === "aceite"
                    ? "Depois de aceite, o orçamento deixa de poder ser alterado — é a base do acordo com o cliente."
                    : t === "anulado"
                      ? "Um orçamento anulado não volta atrás."
                      : "Pode voltar a rever o orçamento depois, criando uma revisão nova."
                }
                confirmLabel={QUOTE_STATUS_LABELS[t]}
                variant={t === "anulado" || t === "recusado" ? "destructive" : undefined}
                onConfirm={() => mudarEstado(t)}
              />
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
