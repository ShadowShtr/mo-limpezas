"use client";

// ============================================================================
// A lista de orçamentos
// ============================================================================
//
// 🔴 Mostra só as revisões vivas. A action já filtra `superseded_by_id IS NULL`
//    — sem isso, a R0 e a R1 do mesmo documento apareceriam lado a lado e
//    ninguém saberia qual vale.
// ============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FilePlus2, FileText, Mail, TriangleAlert } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { usePagination, Pagination } from "@/components/ui/pagination";
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  isQuoteStatus,
  isExpired,
  type QuoteStatus,
} from "@/lib/crm/quotes";
import { formatEur } from "@/domain/crm/quote-totals";
import { getQuote, type QuoteRow } from "@/app/actions/crm-orcamentos";
import type { LeadRow } from "@/app/actions/crm-leads";

import { QuoteSheet } from "./quote-sheet";
import { QuoteDetailSheet } from "./quote-detail-sheet";

interface Props {
  orcamentos: QuoteRow[] | null;
  erro: string | null;
  leads: LeadRow[];
  /** `null` quando as configurações não puderam ser lidas — ver a página. */
  vatRate: number | null;
  hoje: string;
}

const CORES: Record<QuoteStatus, string> = {
  rascunho: "bg-slate-100 text-slate-600",
  enviado: "bg-blue-50 text-blue-700",
  aceite: "bg-green-50 text-green-700",
  recusado: "bg-red-50 text-red-700",
  expirado: "bg-amber-50 text-amber-700",
  anulado: "bg-slate-100 text-slate-500",
};

function fmtData(iso: string | null): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

export function QuotesClient({ orcamentos, erro, leads, vatRate, hoje }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [carregando, startTransition] = useTransition();

  const [filtro, setFiltro] = useState("");
  const [aCriar, setACriar] = useState(false);
  const [aberto, setAberto] = useState<QuoteRow | null>(null);

  const lista = orcamentos ?? [];
  const filtrados = filtro ? lista.filter((q) => q.status === filtro) : lista;
  const paginacao = usePagination(filtrados, 10);

  /** Abre a ficha, buscando as linhas — a lista não as traz. */
  function abrir(id: string) {
    startTransition(async () => {
      const res = await getQuote(id);
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      setAberto(res.data);
    });
  }

  if (erro) {
    return (
      <div className="rounded-xl border bg-white p-8 text-center" style={{ borderColor: "var(--color-border)" }}>
        <TriangleAlert className="mx-auto h-8 w-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">Não foi possível carregar os orçamentos.</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-muted)" }}>{erro}</p>
      </div>
    );
  }

  const porFechar = lista.filter((q) => q.status === "enviado").length;
  const valorPorFechar = lista
    .filter((q) => q.status === "enviado")
    .reduce((s, q) => s + Number(q.total), 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setACriar(true)}
          disabled={vatRate === null}
          title={vatRate === null ? "Falta o IVA nas Configurações" : undefined}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          style={{ background: "#16A34A" }}
        >
          <FilePlus2 className="h-4 w-4" />
          Novo orçamento
        </button>

        <select
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="rounded-lg border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--color-border)" }}
          aria-label="Filtrar por estado"
        >
          <option value="">Todos os estados</option>
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>{QUOTE_STATUS_LABELS[s]}</option>
          ))}
        </select>

        {porFechar > 0 && (
          <span className="ml-auto text-[13px]" style={{ color: "var(--color-text-muted)" }}>
            {porFechar} por fechar · {formatEur(valorPorFechar)}
          </span>
        )}
      </div>

      {vatRate === null && (
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-[12.5px] text-amber-800">
          Não foi possível ler o IVA configurado para a empresa. Enquanto isso
          não estiver resolvido nas Configurações, não se emitem orçamentos —
          um documento com a taxa errada vai para o cliente e fica lá.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: "var(--color-border)" }}>
        {filtrados.length === 0 ? (
          <p className="p-8 text-center text-[13px]" style={{ color: "var(--color-text-muted)" }}>
            Ainda não há orçamentos.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead
                className="border-b text-[11.5px] uppercase tracking-wide"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
              >
                <tr>
                  <th className="px-4 py-2.5 font-medium">Número</th>
                  <th className="px-4 py-2.5 font-medium">Cliente / Lead</th>
                  <th className="px-4 py-2.5 font-medium">Data</th>
                  <th className="px-4 py-2.5 font-medium text-right">Total</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {paginacao.pageItems.map((q) => {
                  const estado = isQuoteStatus(q.status) ? q.status : null;
                  // Um enviado cuja validade passou mostra-se como expirado:
                  // o estado não é escrito na base (ver a 103), é derivado.
                  const expirado = estado ? isExpired(estado, q.valid_until, hoje) : false;
                  const mostrar: QuoteStatus | null = expirado ? "expirado" : estado;

                  return (
                    <tr key={q.id} className="border-b last:border-0" style={{ borderColor: "var(--color-border)" }}>
                      <td className="px-4 py-3 whitespace-nowrap font-medium">
                        {q.quote_number}
                      </td>
                      <td className="px-4 py-3">
                        {q.lead_id ? (
                          <Link href={`/dashboard/crm/${q.lead_id}`} style={{ color: "#16A34A" }}>
                            {q.target_name}
                          </Link>
                        ) : (
                          q.target_name
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {fmtData(q.issue_date)}
                        <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                          até {fmtData(q.valid_until)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap font-medium">
                        {formatEur(Number(q.total))}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
                            mostrar ? CORES[mostrar] : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {mostrar ? QUOTE_STATUS_LABELS[mostrar] : q.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => abrir(q.id)}
                          disabled={carregando}
                          className="rounded-lg border px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-50"
                          style={{ borderColor: "var(--color-border)" }}
                        >
                          Abrir
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filtrados.length > 0 && <Pagination {...paginacao} hideWhenSinglePage />}

      {lista.length === 0 && (
        <div
          className="mt-4 flex items-start gap-3 rounded-xl border p-4"
          style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
        >
          <FileText className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--color-text-muted)" }} />
          <p className="text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
            Um orçamento nasce como rascunho. Depois de o enviar, deixa de se
            poder editar em cima: qualquer alteração cria uma revisão nova
            (R1, R2…), para que o documento que o cliente recebeu não mude por
            baixo dele. <Mail className="inline h-3 w-3" /> O envio por email
            leva o PDF em anexo.
          </p>
        </div>
      )}

      {aCriar && vatRate !== null && (
        <QuoteSheet
          leads={leads}
          vatRate={vatRate}
          onClose={() => setACriar(false)}
          onDone={(numero) => {
            setACriar(false);
            toast(`Orçamento ${numero} criado.`, "success");
            router.refresh();
          }}
        />
      )}

      {aberto && (
        <QuoteDetailSheet
          quote={aberto}
          hoje={hoje}
          onClose={() => setAberto(null)}
          onChanged={() => {
            setAberto(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
