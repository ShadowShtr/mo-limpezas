"use client";

// ============================================================================
// A lista de orçamentos
// ============================================================================
//
// Lista, e não quadro: a pergunta real é «o que está por responder?», a que
// uma lista ordenada por número decrescente responde melhor — e o número já
// carrega a ordem cronológica dentro do ano.
//
// 🔴 SÓ AS REVISÕES VIVAS. As substituídas não entram aqui.
//
//    Uma versão anterior deste ecrã mostrava a cadeia toda, esbatendo as
//    substituídas. Parecia mais informativo e era pior: com R0 «enviado» e R1
//    «rascunho» (a viva), a lista mostrava as duas e o filtro «Enviado»
//    contava a R0 — um orçamento que já não está em vigor, a inflar o número
//    de propostas por responder. Quem olhasse para o ecrã para saber o que
//    tinha em cima da mesa via trabalho que não existe.
//
//    O filtro é de `getQuotes`, no servidor, e não uma escolha deste
//    componente: uma lista que recebe demais e esconde no cliente continua a
//    trazer demais para o browser, e a contar mal em qualquer sítio onde
//    alguém use o comprimento do array.
//
//    Nada se perde. A base guarda R0 e R1 na íntegra, e
//    `getQuotes({ incluirSubstituidas: true })` devolve a cadeia toda no dia
//    em que houver uma vista de histórico. Não há nenhuma neste ciclo.
// ============================================================================

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FilePlus2, TriangleAlert } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { usePagination, Pagination } from "@/components/ui/pagination";
import {
  isQuoteStatus,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  type QuoteStatus,
} from "@/lib/crm/quotes";
import type { QuoteRow, QuoteWithItems } from "@/app/actions/crm-orcamentos";
import type { VisitRow } from "@/app/actions/crm-visitas";
import type { LeadRow } from "@/app/actions/crm-leads";

import { QuoteSheet, type ClienteOpcao } from "./quote-sheet";
import { QuoteDetailSheet } from "./quote-detail-sheet";

interface Props {
  orcamentos: QuoteRow[] | null;
  erro: string | null;
  leads: LeadRow[];
  clientes: ClienteOpcao[];
  visitas: VisitRow[];
  empresaNome: string;
  vatRate: number | null;
}

const CORES: Record<QuoteStatus, string> = {
  rascunho: "bg-slate-100 text-slate-600",
  enviado: "bg-blue-50 text-blue-700",
  aceite: "bg-green-50 text-green-700",
  recusado: "bg-red-50 text-red-700",
  expirado: "bg-amber-50 text-amber-700",
  anulado: "bg-slate-100 text-slate-500",
};

const fmtEur = (v: number): string =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

const fmtDate = (iso: string): string =>
  new Intl.DateTimeFormat("pt-PT", { dateStyle: "short", timeZone: "Europe/Lisbon" })
    .format(new Date(`${iso}T12:00:00Z`));

export function QuotesClient({
  orcamentos,
  erro,
  leads,
  clientes,
  visitas,
  empresaNome,
  vatRate,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();

  const [filtroEstado, setFiltroEstado] = useState<string>("");
  const [aCriar, setACriar] = useState(false);
  const [aVer, setAVer] = useState<QuoteRow | null>(null);
  /** A versão a partir da qual se está a criar uma revisão. */
  const [aRevir, setARevir] = useState<QuoteWithItems | null>(null);
  /**
   * O rascunho que está a ser corrigido IN PLACE.
   *
   * 🔴 Estado PRÓPRIO, e não `aRevir` reaproveitado. As duas operações têm
   *    significados opostos — rever cria um documento novo, editar corrige o
   *    mesmo — e uma variável partilhada obrigaria cada leitura a adivinhar
   *    qual delas está em curso.
   *
   * 🔴 Guarda o `QuoteWithItems` da leitura FRESCA do detalhe, e é de lá que
   *    sai o `updated_at` que serve de token de concorrência.
   */
  const [aEditar, setAEditar] = useState<QuoteWithItems | null>(null);

  // 🔴 `orcamentos ?? []` DENTRO do `useMemo`, e não numa const acima: um
  //    literal novo a cada render invalidaria a memoização em todos eles.
  const filtrados = useMemo(() => {
    const lista = orcamentos ?? [];
    return filtroEstado ? lista.filter((q) => q.status === filtroEstado) : lista;
  }, [orcamentos, filtroEstado]);
  const paginacao = usePagination(filtrados, 12);

  if (erro) {
    return (
      <div
        className="rounded-xl border bg-white p-8 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <TriangleAlert className="mx-auto h-8 w-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">Não foi possível carregar os orçamentos.</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-muted)" }}>{erro}</p>
        <button
          onClick={() => startTransition(() => router.refresh())}
          className="mt-4 rounded-lg border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: "var(--color-border)" }}
        >
          Tentar de novo
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setACriar(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
          style={{ background: "#16A34A" }}
        >
          <FilePlus2 className="h-4 w-4" />
          Novo orçamento
        </button>

        <select
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value)}
          className="rounded-lg border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--color-border)" }}
          aria-label="Filtrar por estado"
        >
          <option value="">Todos</option>
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>{QUOTE_STATUS_LABELS[s]}</option>
          ))}
        </select>

        <span className="ml-auto text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {filtrados.length} {filtrados.length === 1 ? "orçamento" : "orçamentos"}
        </span>
      </div>

      <div
        className="overflow-hidden rounded-xl border bg-white"
        style={{ borderColor: "var(--color-border)" }}
      >
        {filtrados.length === 0 ? (
          <p className="p-8 text-center text-[13px]" style={{ color: "var(--color-text-muted)" }}>
            {filtroEstado
              ? "Não há orçamentos com este estado."
              : "Ainda não há orçamentos. Comece por um."}
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
                  <th className="px-4 py-2.5 font-medium">Para</th>
                  <th className="px-4 py-2.5 font-medium">Emitido</th>
                  <th className="px-4 py-2.5 font-medium">Validade</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {paginacao.pageItems.map((q) => {
                  const estado = isQuoteStatus(q.status) ? q.status : null;
                  return (
                    <tr
                      key={q.id}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      {/*
                        Sem marca de «histórico»: aqui só chegam revisões
                        vivas. O aviso de versão substituída vive no detalhe,
                        que abre qualquer versão pelo seu id — incluindo uma
                        que tenha sido substituída entretanto.
                      */}
                      <td className="px-4 py-3 whitespace-nowrap font-medium">
                        {q.quote_number}
                      </td>
                      <td className="px-4 py-3">
                        {/*
                          🔴 A ficha liga-se pela PROVENIÊNCIA (`source_lead_id`),
                             e não por `lead_id`: depois da conversão (104) o
                             `lead_id` fica a NULL e o caminho de volta à lead
                             que gerou o negócio perder-se-ia.
                        */}
                        {q.source_lead_id ? (
                          <Link
                            href={`/dashboard/crm/${q.source_lead_id}`}
                            className="font-medium"
                            style={{ color: "#16A34A" }}
                          >
                            {q.target_name}
                          </Link>
                        ) : (
                          <span className="font-medium">{q.target_name}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{fmtDate(q.issue_date)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{fmtDate(q.valid_until)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{fmtEur(q.total)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
                            estado ? CORES[estado] : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {estado ? QUOTE_STATUS_LABELS[estado] : q.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => setAVer(q)}
                          className="rounded-lg border px-2.5 py-1 text-[12.5px] font-medium"
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

      {aCriar && (
        <QuoteSheet
          leads={leads}
          clientes={clientes}
          visitas={visitas}
          vatRate={vatRate}
          mode="create"
          onClose={() => setACriar(false)}
          onDone={(numero) => {
            setACriar(false);
            toast(`Orçamento ${numero} criado.`, "success");
            router.refresh();
          }}
        />
      )}

      {aRevir && (
        <QuoteSheet
          leads={leads}
          clientes={clientes}
          visitas={visitas}
          vatRate={vatRate}
          mode="revise"
          base={aRevir}
          onClose={() => setARevir(null)}
          onDone={(numero) => {
            setARevir(null);
            setAVer(null);
            toast(`Revisão ${numero} criada, em rascunho.`, "success");
            router.refresh();
          }}
        />
      )}

      {aEditar && (
        <QuoteSheet
          leads={leads}
          clientes={clientes}
          visitas={visitas}
          vatRate={vatRate}
          mode="edit-draft"
          base={aEditar}
          onClose={() => setAEditar(null)}
          onDone={(numero) => {
            // 🔴 Só aqui. `onDone` NÃO é chamado quando a action falha — e é
            //    isso que mantém o formulário aberto num `QUOTE_DRAFT_STALE`,
            //    com o trabalho da pessoa à frente dela, para decidir depois
            //    de recarregar. Fechar e perder o que escreveu seria castigá-la
            //    por outra pessoa ter gravado primeiro.
            setAEditar(null);
            toast(`Orçamento ${numero} actualizado.`, "success");
            router.refresh();
          }}
        />
      )}

      {aVer && (
        <QuoteDetailSheet
          orcamento={aVer}
          empresaNome={empresaNome}
          onClose={() => setAVer(null)}
          onChanged={() => {
            setAVer(null);
            router.refresh();
          }}
          onRevise={(base) => {
            // O detalhe fecha-se; o formulário de revisão abre com as linhas
            // da versão que se está a substituir.
            setAVer(null);
            setARevir(base);
          }}
          onEditDraft={(base) => {
            // 🔴 `base` vem da leitura FRESCA que o detalhe fez com `getQuote`,
            //    e não da linha da lista. É de lá que sai o `updated_at`: o
            //    token tem de descrever o documento como ele está agora, não
            //    como estava quando a listagem foi construída.
            setAVer(null);
            setAEditar(base);
          }}
        />
      )}
    </div>
  );
}
