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
//    O modo é EXPLÍCITO, num prop discriminado: `create`, `revise` ou
//    `edit-draft`.
//
// 🔴 Antes o modo era inferido de `base` estar presente, e isso deixou de
//    chegar quando apareceu o terceiro fluxo. `base` presente passaria a
//    querer dizer «revisão OU edição» — uma variável com dois significados, e
//    cada `if (base)` do ficheiro teria de adivinhar qual deles. Um prop
//    discriminado obriga o TypeScript a exigir a decisão em quem chama, e
//    cada modo fica com as suas invariantes.
//
// ---------------------------------------------------------------------------
// 🔴 EDITAR UM RASCUNHO NÃO É REVER
// ---------------------------------------------------------------------------
//
//   · rever cria um DOCUMENTO NOVO (R1), porque o anterior já saiu para o
//     cliente. Datas de hoje, número novo, o anterior fica no histórico;
//
//   · editar corrige o MESMO documento, que nunca saiu. Datas PERSISTIDAS,
//     mesmo número, mesma revisão, mesmo destinatário. O que muda é só o
//     conteúdo — e quem já tinha o formulário aberto com uma versão velha é
//     recusado com `QUOTE_DRAFT_STALE` em vez de apagar o trabalho de outro.
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
  excedeMontanteMaximo,
  hasMaxDecimalPlaces,
  QUOTE_AMOUNT_MESSAGE,
  QUOTE_DISCOUNT_DECIMAL_MESSAGE,
  QUOTE_DISCOUNT_MAX_DECIMAL_PLACES,
  QUOTE_ITEM_DECIMAL_MESSAGE,
  QUOTE_ITEM_MAX_DECIMAL_PLACES,
  QUOTE_DEFAULT_VALIDITY_DAYS,
  QUOTE_PRICING_KINDS,
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_UNITS,
  QUOTE_UNIT_LABELS,
  totaisDoOrcamento,
  type QuotePricingKind,
  type QuoteUnit,
} from "@/lib/crm/quotes";
import {
  createQuote,
  editDraftQuote,
  reviseQuote,
  type QuoteWithItems,
} from "@/app/actions/crm-orcamentos";
import type { VisitRow } from "@/app/actions/crm-visitas";
import type { LeadRow } from "@/app/actions/crm-leads";

const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

export interface ClienteOpcao {
  id: string;
  name: string;
}

interface PropsComuns {
  leads: LeadRow[];
  clientes: ClienteOpcao[];
  visitas: VisitRow[];
  /**
   * A taxa das DEFINIÇÕES, só para a pré-visualização de um documento novo.
   * Nula quando as definições não carregaram.
   *
   * 🔴 No modo `edit-draft` esta taxa NÃO é usada: ver `taxaDaPrevisao`.
   */
  vatRate: number | null;
  onClose: () => void;
  onDone: (numero: string) => void;
}

/**
 * 🔴 Props DISCRIMINADAS por `mode`.
 *
 *    `revise` e `edit-draft` exigem `base`; `create` não o aceita. É o
 *    compilador a impedir que alguém abra o formulário de edição sem o
 *    documento que vai ser editado — e é o que torna `base.quote.updated_at`
 *    seguro de usar como token de concorrência.
 */
type Props = PropsComuns & (
  | { mode: "create"; base?: undefined }
  | { mode: "revise"; base: QuoteWithItems }
  | { mode: "edit-draft"; base: QuoteWithItems }
);

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
  mode,
  base,
  onClose,
  onDone,
}: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [erros, setErros] = useState<Record<string, string[]>>({});

  const eRevisao = mode === "revise";
  const eEdicao = mode === "edit-draft";
  const hoje = todayInLisbon();

  // 🔴 Na edição o destinatário vem do documento e NÃO se escolhe. Fica em
  //    estado na mesma porque é ele que filtra as visitas compatíveis — o
  //    selector de visita continua a ser editável, e uma visita de outro
  //    destinatário é recusada pela RPC com `QUOTE_VISIT_MISMATCH`.
  const [alvoTipo, setAlvoTipo] = useState<AlvoTipo>(
    eEdicao && base?.quote.client_id ? "cliente" : "lead",
  );
  const [leadId, setLeadId] = useState(eEdicao ? (base?.quote.lead_id ?? "") : "");
  const [clientId, setClientId] = useState(eEdicao ? (base?.quote.client_id ?? "") : "");
  const [visitId, setVisitId] = useState(eEdicao ? (base?.quote.visit_id ?? "") : "");

  // 🔴 As datas de uma revisão são de HOJE, e não as herdadas da versão
  //    anterior.
  //
  //    A primeira versão punha `base.quote.issue_date` aqui, com o raciocínio
  //    de que o formulário devia abrir com o que a R0 tinha. Está errado por
  //    dois motivos, e o segundo faz estragos:
  //
  //      · uma R1 emitida hoje não foi emitida na data da R0 — a data de
  //        emissão de um documento é o dia em que ele existe;
  //
  //      · uma R0 de há três meses traz consigo uma validade de há dois. A
  //        revisão nascia JÁ EXPIRADA, passava o CHECK (`valid_until >=
  //        issue_date`, ambos no passado) e só falhava muito mais tarde, com
  //        `QUOTE_EXPIRED_CANNOT_ACCEPT`, quando alguém tentasse aceitar o
  //        orçamento que o cliente já tinha aprovado. A saída seria marcar
  //        enviado e rever outra vez — um número queimado e uma revisão de
  //        lixo na cadeia.
  //
  //    Herdam-se os valores que descrevem o NEGÓCIO (linhas, desconto, IVA).
  //    Não se herda o que descreve o documento no tempo.
  // 🔴 Na EDIÇÃO as datas são as PERSISTIDAS, e o raciocínio acima não se
  //    aplica: não nasce documento nenhum, é o mesmo que está a ser corrigido.
  //    Abrir com «hoje» faria uma correcção de gralha mudar a data de emissão
  //    do orçamento sem ninguém pedir.
  const [issueDate, setIssueDate] = useState(eEdicao ? base!.quote.issue_date : hoje);
  const [validUntil, setValidUntil] = useState(
    eEdicao ? base!.quote.valid_until : addDaysToDateString(hoje, QUOTE_DEFAULT_VALIDITY_DAYS),
  );
  const [pricingKind, setPricingKind] = useState<QuotePricingKind>(
    eEdicao && (QUOTE_PRICING_KINDS as readonly string[]).includes(base!.quote.pricing_kind)
      ? (base!.quote.pricing_kind as QuotePricingKind)
      : "pontual",
  );
  const [discountPct, setDiscountPct] = useState(
    base ? String(base.quote.discount_pct) : "0",
  );
  const [applyVat, setApplyVat] = useState(base?.quote.apply_vat ?? true);
  const [proposedFrequency, setProposedFrequency] = useState(
    eEdicao ? (base!.quote.proposed_frequency ?? "") : "",
  );
  const [paymentTerms, setPaymentTerms] = useState(
    eEdicao ? (base!.quote.payment_terms ?? "") : "",
  );
  const [notes, setNotes] = useState(base?.quote.notes ?? "");
  const [internalNotes, setInternalNotes] = useState(
    eEdicao ? (base!.quote.internal_notes ?? "") : "",
  );

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

  const descontoNumerico = Number(discountPct.replace(",", ".")) || 0;

  /**
   * 🔴 Algum valor escrito está fora do domínio que a aritmética reproduz?
   *
   *    Seis casas decimais é o limite, e a regra autoritativa é a do servidor
   *    (`crm-orcamentos.ts` recusa antes da RPC). Esta é a mesma regra, aqui,
   *    só para dar resposta imediata — e sobretudo para NÃO MOSTRAR UM TOTAL
   *    que a base não vai confirmar. 100000 × 0,000000051 dá 0,01 na base e
   *    0,00 aqui: um preview com esse número seria uma promessa falsa.
   */
  /**
   * 🔴 Duas casas nas linhas, porque `quantity` e `unit_price` são
   *    `numeric(10,2)`. Não é a escala da aritmética — é a da coluna.
   *
   *    Com mais casas o documento deixava de fechar consigo próprio: 0,335
   *    persiste como 0,34 e a linha vale 1,01, quando 3 × 0,34 dá 1,02.
   */
  const foraDeDominio = useMemo(
    () =>
      itensNumericos.some(
        (i) =>
          !hasMaxDecimalPlaces(i.quantity, QUOTE_ITEM_MAX_DECIMAL_PLACES)
          || !hasMaxDecimalPlaces(i.unit_price, QUOTE_ITEM_MAX_DECIMAL_PLACES),
      ),
    [itensNumericos],
  );

  /**
   * 🔴 O desconto tem escala própria: duas casas, porque `discount_pct` é
   *    `numeric(5,2)`. Com mais, o documento persistiria «3,14 %» e os totais
   *    corresponderiam a 3,141592 % — o número que se lê deixava de ser o
   *    número que fez a conta.
   */
  const descontoForaDeDominio = useMemo(
    () => !hasMaxDecimalPlaces(descontoNumerico, QUOTE_DISCOUNT_MAX_DECIMAL_PLACES),
    [descontoNumerico],
  );

  /**
   * 🔴 A taxa que a PRÉ-VISUALIZAÇÃO usa depende do modo, e a diferença é de
   *    produto, não de implementação.
   *
   *    Um documento NOVO (criação, revisão) leva a taxa das definições de
   *    hoje. Um rascunho EDITADO leva a que está gravada nele: a
   *    `editDraftQuote` devolve à RPC o `vat_rate` persistido, porque corrigir
   *    uma descrição não pode mudar o IVA de um orçamento por a empresa ter
   *    alterado a taxa entretanto.
   *
   *    Se o ecrã previsse com a taxa de hoje e a base gravasse a do documento,
   *    o total mostrado e o total gravado divergiam — e quem estivesse a
   *    editar veria um número que nunca chegaria a existir.
   */
  const taxaDaPrevisao = eEdicao ? base!.quote.vat_rate : vatRate;

  const previsao = useMemo(
    () =>
      totaisDoOrcamento(itensNumericos, {
        discountPct: descontoNumerico,
        applyVat,
        vatRate: taxaDaPrevisao,
      }),
    [itensNumericos, descontoNumerico, applyVat, taxaDaPrevisao],
  );

  /**
   * 🔴 Cabe em `numeric(10,2)`? O domínio de cada campo isolado não garante:
   *    100 000 × 1 000 000 são ambos aceites e dão 1e11.
   *
   *    Sem isto, o submit seguia e o Postgres respondia `numeric field
   *    overflow` — uma mensagem que ninguém sabe ler. A regra autoritativa é a
   *    do servidor; esta é a mesma, aqui, para não deixar carregar no botão.
   */
  const excedeMaximo = useMemo(() => excedeMontanteMaximo(previsao), [previsao]);

  /** Qualquer coisa que o servidor vai recusar. */
  const invalido = foraDeDominio || descontoForaDeDominio || excedeMaximo;

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
      const res = eEdicao
        ? await editDraftQuote(base!.quote.id, {
            // 🔴 O TOKEN, exactamente como veio da leitura fresca do detalhe.
            //
            //    Nunca `new Date(...)`, nunca `.toISOString()`: `timestamptz`
            //    guarda microssegundos e qualquer reconstrução trunca ao
            //    milissegundo — a RPC recusava com `QUOTE_DRAFT_STALE` e a
            //    pessoa via um conflito inventado. Há um ensaio que fica
            //    vermelho se alguém puser um `Date` neste caminho.
            expectedUpdatedAt: base!.quote.updated_at,
            visitId: visitId || null,
            issueDate,
            validUntil,
            pricingKind,
            discountPct: Number(discountPct.replace(",", ".")) || 0,
            applyVat,
            proposedFrequency: proposedFrequency || null,
            paymentTerms: paymentTerms || null,
            // 🔴 String vazia, e não `null`: na edição um campo esvaziado quer
            //    dizer «tira isto». A 105 substitui o documento inteiro, não
            //    faz COALESCE com o que lá estava.
            notes,
            internalNotes,
            items,
          })
        : eRevisao
        ? await reviseQuote(base!.quote.id, {
            issueDate,
            validUntil,
            discountPct: Number(discountPct.replace(",", ".")) || 0,
            applyVat,
            // 🔴 `notes`, e NÃO `notes || null` — ao contrário da criação, e a
            //    diferença não é descuido.
            //
            //    `revise_crm_quote` grava `COALESCE(p_notes, v_antiga.notes)`:
            //    um `null` quer dizer «herda o que lá estava». Como este campo
            //    abre pré-preenchido com as notas da versão anterior, quem o
            //    esvazia está a dizer «tira isto» — e enviar `null` fazia a
            //    base repor exactamente o texto que a pessoa acabou de apagar.
            //    O ecrã ficava vazio, o PDF saía com as notas velhas, e não
            //    havia forma nenhuma de as remover numa revisão.
            //
            //    Uma string vazia não é `null`: passa pelo COALESCE e limpa.
            notes,
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
    : eEdicao
    ? `Editar ${base?.quote.quote_number}`
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
              {eEdicao ? (
                <>
                  <p
                    className="rounded-lg border px-3 py-2 text-[12.5px]"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                  >
                    Está a corrigir o <strong>{base?.quote.quote_number}</strong>, que ainda está em
                    rascunho. Fica o <strong>mesmo</strong> documento: mesmo número, mesmo
                    destinatário, sem criar revisão. Se alguém o tiver alterado entretanto, nada é
                    guardado e terá de recarregar.
                  </p>

                  {/*
                    🔴 O destinatário VÊ-SE, mas não se troca.

                       Mudar o orçamento da lead A para a lead B por «edição»
                       faria a conversão apontar para quem nunca pediu aquele
                       preço, e a proveniência (`source_lead_id`) é imutável por
                       trigger desde a 103. Se o destinatário está errado, o
                       caminho é anular e emitir outro — não é esconder a
                       verdade num campo editável que a base vai ignorar.
                  */}
                  <div>
                    <span className="text-[12.5px] font-medium">Para quem</span>
                    <p
                      className="mt-1 rounded-lg border px-3 py-2 text-[13px]"
                      style={{
                        borderColor: "var(--color-border)",
                        background: "var(--color-background)",
                      }}
                    >
                      {base?.quote.target_name}
                    </p>
                    <span
                      className="mt-0.5 block text-[11.5px] font-normal"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      O destinatário de um orçamento não se altera. Para o mudar, anule este e
                      emita outro.
                    </span>
                  </div>
                </>
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
                </>
              )}

              {/*
                A visita É editável na correcção de um rascunho: trocar a visita
                errada é justamente uma das coisas que faltavam poder corrigir.
                Uma visita de outro destinatário é recusada pela RPC.
              */}
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
            {invalido ? (
              // 🔴 Nenhum número aqui enquanto houver um valor que o servidor
              //    vai recusar. Mostrar um total que a base não vai confirmar
              //    é pior do que não mostrar total nenhum.
              <p className="text-[12.5px] text-red-600">
                {excedeMaximo
                  ? QUOTE_AMOUNT_MESSAGE
                  : descontoForaDeDominio
                    ? QUOTE_DISCOUNT_DECIMAL_MESSAGE
                    : `${QUOTE_ITEM_DECIMAL_MESSAGE} Há um valor com casas a mais.`}{" "}
                O total só é calculado depois de o corrigir.
              </p>
            ) : (
            <>
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
            </>
            )}
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
            /* Condições de pagamento e notas internas: na revisão a RPC herda-as
               e ignoraria o que aqui fosse escrito; na edição são editáveis. */
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
            disabled={pending || invalido || (!eRevisao && !eEdicao && !alvoEscolhido)}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {pending
              ? "A guardar…"
              : eRevisao
              ? "Criar revisão"
              : eEdicao
              ? "Guardar alterações"
              : "Criar orçamento"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
