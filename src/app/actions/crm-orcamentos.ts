"use server";

// ============================================================================
// CRM — os orçamentos
// ============================================================================
//
// 🔴 Só funções assíncronas. As constantes vivem em `src/lib/crm/quotes.ts`.
//
// ---------------------------------------------------------------------------
// 🔴 TODA a escrita passa por RPC. Zero `.from("crm_quotes").insert|update`.
// ---------------------------------------------------------------------------
//
// Não é preferência de estilo. Um orçamento é cabeçalho + linhas + número, e
// as três coisas só fazem sentido juntas:
//
//   · o NÚMERO é escolhido sob `pg_advisory_xact_lock` por empresa e ano. Duas
//     criações simultâneas escolhidas em JavaScript leriam o mesmo máximo e
//     pediriam o mesmo número — e um `ORC2026/001` duplicado, com um deles já
//     na mão de um cliente, é o pior desfecho possível (é a razão por extenso
//     no cabeçalho da 103);
//
//   · as LINHAS e o cabeçalho têm de nascer na mesma transação. Em dois
//     pedidos, um processo que morra a meio deixa um orçamento com totais
//     certos e zero linhas, com o aspecto de um documento normal. Foi
//     exactamente o defeito que a 072 fechou nas facturas;
//
//   · os TOTAIS são calculados no servidor. `line_total` vindo do cliente
//     deixaria uma linha de 10 × 50 € dizer 100 €.
//
// As três RPC, e mais nada:
//
//     create_crm_quote_with_items   revise_crm_quote   set_crm_quote_status
//
// `crm-orcamentos-guard.test.ts` conta as escritas directas e exige zero.
//
// ---------------------------------------------------------------------------
// 🔴 EDIÇÃO DE UM RASCUNHO: NÃO EXISTE NESTE CICLO, e é deliberado
// ---------------------------------------------------------------------------
//
// `revise_crm_quote` recusa um rascunho de propósito (`QUOTE_DRAFT_EDIT_IN_PLACE`):
// revisão é para documentos que já saíram, e criar uma R1 de um rascunho que
// ninguém viu só enche a cadeia de revisões com ruído.
//
// Corrigir um rascunho in-place exigiria, numa só transação:
//
//     UPDATE crm_quotes …  +  DELETE crm_quote_items …  +  INSERT crm_quote_items …
//
// Em três chamadas separadas do lado da aplicação isso NÃO é atómico: uma
// falha depois do DELETE deixa o rascunho sem linhas nenhumas — o mesmo
// documento fantasma que a RPC de criação existe para impedir. Não se resolve
// com um try/catch de compensação; resolve-se com uma RPC.
//
//     DRAFT_EDIT_REQUIRES_ATOMIC_RPC = YES
//
// A migration dessa RPC não vem escondida nesta PR. Até lá, um rascunho errado
// anula-se (`set_crm_quote_status` → `anulado`) e faz-se outro — o sequencial
// avança, e um número queimado é mais barato do que um documento partido.
//
// ---------------------------------------------------------------------------
// Fronteiras deste ciclo (103-B1)
// ---------------------------------------------------------------------------
//
// Fora daqui, por decisão da direcção, e nada neste ficheiro os importa:
//   · envio por email / Resend / outbox / templates  → 103-B2
//   · conversão lead → cliente/local                 → 104-A
//
// E, como no resto do CRM: um orçamento NUNCA cria serviço, contrato, local,
// factura ou movimento de caixa. Orçamentar não é facturar.
// ============================================================================

import { z } from "zod";

import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  validationFailure,
  type ActionErrorCode,
  type ActionResult,
} from "@/lib/action-result";
import { AUTH_GUARD_CODES, requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";
import { logQueryFailure } from "@/lib/query-error";
import {
  QUOTE_PRICING_KINDS,
  QUOTE_STATUSES,
  QUOTE_UNITS,
  type QuoteStatus,
} from "@/lib/crm/quotes";

/** O cabeçalho de um orçamento, como a lista e o detalhe o mostram. */
export interface QuoteRow {
  id: string;
  quote_number: string;
  quote_year: number;
  quote_seq: number;
  revision: number;
  root_quote_id: string;
  superseded_by_id: string | null;
  lead_id: string | null;
  client_id: string | null;
  /**
   * 🔴 De que lead NASCEU. Proveniência imutável, distinta de `lead_id` (o
   *    destinatário actual). Ver a nota extensa na 103: uma coluna não pode
   *    ser ao mesmo tempo estado corrente e facto histórico.
   */
  source_lead_id: string | null;
  visit_id: string | null;
  /** Nome da lead ou do cliente a quem está endereçado, resolvido na leitura. */
  target_name: string;
  issue_date: string;
  valid_until: string;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  pricing_kind: string;
  subtotal: number;
  discount_pct: number;
  apply_vat: boolean;
  vat_rate: number;
  vat_amount: number;
  total: number;
  proposed_frequency: string | null;
  proposed_weekdays: unknown;
  payment_terms: string | null;
  notes: string | null;
  /**
   * 🔴 Notas internas. Chegam ao ecrã de quem é admin/gestor — e a mais
   *    ninguém, porque a RLS de `crm_quotes` não deixa outro papel ler a
   *    tabela. NUNCA vão para o PDF: ver `quote-pdf.ts`.
   */
  internal_notes: string | null;
  created_at: string;
}

export interface QuoteItemRow {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
}

/** Um orçamento com as suas linhas — o que o detalhe e o PDF precisam. */
export interface QuoteWithItems {
  quote: QuoteRow;
  items: QuoteItemRow[];
}

// 🔴 Nunca `select("*")`: uma coluna nova passaria a viajar para o cliente sem
//    ninguém decidir que devia.
const QUOTE_SELECT = `
  id, quote_number, quote_year, quote_seq, revision, root_quote_id, superseded_by_id,
  lead_id, client_id, source_lead_id, visit_id,
  issue_date, valid_until, status, sent_at, accepted_at, rejected_at, rejection_reason,
  pricing_kind, subtotal, discount_pct, apply_vat, vat_rate, vat_amount, total,
  proposed_frequency, proposed_weekdays, payment_terms, notes, internal_notes, created_at
`;

const ITEM_SELECT = "id, position, description, quantity, unit, unit_price, line_total";

function recusa(code: string): ActionResult<never> {
  if (code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
    return actionFailure(ACTION_ERROR_CODES.UNAUTHENTICATED, "Não autenticado.");
  }
  if (code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Perfil não encontrado.");
  }
  return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para gerir orçamentos.");
}

/**
 * Traduz o erro de uma RPC da 103 numa mensagem que se entende.
 *
 * 🔴 O `error.message` cru do Supabase NÃO chega ao ecrã: expõe nomes de
 *    tabelas e restrições a quem não tem nada com isso, e não ajuda ninguém.
 *    O detalhe vai para o log; o utilizador recebe a frase.
 *
 *    A correspondência é por SENTINELA — os `RAISE EXCEPTION` da 103 começam
 *    todos por um código estável (`QUOTE_…`). Comparar texto em português
 *    seria frágil; comparar o código não.
 */
const SENTINELAS: ReadonlyArray<readonly [string, ActionErrorCode, string]> = [
  ["QUOTE_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado."],
  ["QUOTE_ACCEPTED_IMMUTABLE", ACTION_ERROR_CODES.CONFLICT,
    "Um orçamento aceite não se altera. Faça um orçamento novo."],
  ["QUOTE_VOIDED_IMMUTABLE", ACTION_ERROR_CODES.CONFLICT,
    "Este orçamento foi anulado e já não se altera."],
  ["QUOTE_ALREADY_SUPERSEDED", ACTION_ERROR_CODES.CONFLICT,
    "Já existe uma revisão mais recente deste orçamento. Recarregue a lista para a ver."],
  ["QUOTE_DRAFT_EDIT_IN_PLACE", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Um rascunho não se revê. Anule-o e faça outro."],
  ["QUOTE_TRANSITION_NOT_ALLOWED", ACTION_ERROR_CODES.CONFLICT,
    "O estado do orçamento entretanto mudou. Recarregue a lista para ver o actual."],
  ["QUOTE_EXPIRED_CANNOT_ACCEPT", ACTION_ERROR_CODES.BUSINESS_RULE,
    "A validade deste orçamento já passou. Faça uma revisão com validade nova antes de o marcar como aceite."],
  ["QUOTE_VISIT_MISMATCH", ACTION_ERROR_CODES.BUSINESS_RULE,
    "A visita escolhida não é deste destinatário."],
  ["CRM_QUOTE_ITEMS_MISMATCH", ACTION_ERROR_CODES.PERSISTENCE,
    "As linhas do orçamento não ficaram gravadas. Nada foi guardado."],
  ["QUOTE_SOURCE_LEAD_IMMUTABLE", ACTION_ERROR_CODES.CONFLICT,
    "A lead de origem de um orçamento não se altera."],
];

function erroDaRpc(onde: string, message: string | undefined): ActionResult<never> {
  logQueryFailure(onde, { message: message ?? "sem mensagem" });

  const texto = message ?? "";
  for (const [sentinela, code, frase] of SENTINELAS) {
    if (texto.includes(sentinela)) return actionFailure(code, frase);
  }

  // Sem sentinela conhecida é falha técnica: o detalhe fica no log.
  return internalFailure(onde, new Error(texto), ACTION_ERROR_CODES.PERSISTENCE);
}

type AdminClient = Extract<Awaited<ReturnType<typeof requireProfile>>, { ok: true }>["admin"];

/**
 * Resolve os nomes dos destinatários de uma vez, para o conjunto todo.
 *
 * Um join por linha custaria N pedidos, e uma falha a resolver nomes não pode
 * esconder a lista — daí o `?? "—"` no fim, e não um erro.
 */
async function nomesDosDestinatarios(
  admin: AdminClient,
  companyId: string,
  linhas: ReadonlyArray<{ lead_id: string | null; client_id: string | null }>,
): Promise<Map<string, string>> {
  const nomes = new Map<string, string>();

  const leadIds = [...new Set(linhas.map((q) => q.lead_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(linhas.map((q) => q.client_id).filter(Boolean))] as string[];

  if (leadIds.length > 0) {
    const { data } = await admin
      .from("crm_leads")
      .select("id, name")
      .eq("company_id", companyId)
      .in("id", leadIds);
    for (const l of data ?? []) nomes.set(l.id, l.name);
  }
  if (clientIds.length > 0) {
    const { data } = await admin
      .from("clients")
      .select("id, name")
      .eq("company_id", companyId)
      .in("id", clientIds);
    for (const c of data ?? []) nomes.set(c.id, c.name);
  }

  return nomes;
}

// ── Leituras ────────────────────────────────────────────────────────────────

/**
 * Os orçamentos da empresa, do mais recente para o mais antigo.
 *
 * ---------------------------------------------------------------------------
 * 🔴 POR OMISSÃO, SÓ AS REVISÕES VIVAS (`superseded_by_id IS NULL`).
 * ---------------------------------------------------------------------------
 *
 * A lista operacional responde a uma pergunta só: **qual é o orçamento que
 * vale agora?**
 *
 * Sem este filtro, uma cadeia revista aparece duas vezes e mente nas contas.
 * Com R0 `enviado` e R1 `rascunho` (a viva), a lista mostrava as duas e o
 * filtro «Enviado» continuava a contar a R0 — um orçamento que já não está em
 * vigor, a inflar o número de propostas por responder. Quem olhasse para o
 * ecrã para saber o que tinha em cima da mesa via trabalho que não existe.
 *
 * A base continua a guardar R0 e R1 na íntegra: isto é uma decisão de LEITURA,
 * não de retenção. Nada se apaga, e `getQuote(id)` abre qualquer versão pelo
 * seu id, viva ou histórica.
 *
 * `incluirSubstituidas: true` devolve a cadeia completa, para quando existir
 * uma vista de histórico. Não há nenhuma neste ciclo — o parâmetro existe para
 * que a vista futura não tenha de reabrir esta função e mudar o default por
 * baixo de quem já depende dele.
 *
 * `leadId` filtra por PROVENIÊNCIA (`source_lead_id`), e não por `lead_id`.
 * 🔴 A diferença conta: depois da conversão (104) `lead_id` fica a NULL, e um
 *    filtro por ele deixaria de encontrar justamente o orçamento que fechou o
 *    negócio — que é o que se quer ver ao abrir a ficha da lead.
 */
export async function getQuotes(opts?: {
  leadId?: string;
  clientId?: string;
  status?: QuoteStatus;
  /** 🔴 Só para uma vista de histórico. A lista operacional não passa isto. */
  incluirSubstituidas?: boolean;
}): Promise<ActionResult<QuoteRow[]>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  let query = admin
    .from("crm_quotes")
    .select(QUOTE_SELECT)
    .eq("company_id", profile.company_id);

  // 🔴 `!== true`, e não `!opts?.incluirSubstituidas`: o filtro é o default, e
  //    só um `true` explícito o desliga. Um valor indefinido, nulo ou vindo de
  //    um objecto de opções mal construído cai do lado seguro — a lista
  //    operacional.
  if (opts?.incluirSubstituidas !== true) query = query.is("superseded_by_id", null);

  if (opts?.leadId) query = query.eq("source_lead_id", opts.leadId);
  if (opts?.clientId) query = query.eq("client_id", opts.clientId);
  if (opts?.status) query = query.eq("status", opts.status);

  const { data, error } = await query
    .order("quote_year", { ascending: false })
    .order("quote_seq", { ascending: false })
    .order("revision", { ascending: false });

  if (error) {
    logQueryFailure("getQuotes", error);
    return internalFailure("getQuotes", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const linhas = (data ?? []) as unknown as Omit<QuoteRow, "target_name">[];
  const nomes = await nomesDosDestinatarios(admin, profile.company_id, linhas);

  return actionSuccess(
    linhas.map((q) => ({
      ...q,
      target_name: nomes.get((q.lead_id ?? q.client_id) as string) ?? "—",
    })),
  );
}

/** Um orçamento com as suas linhas, por posição. */
export async function getQuote(quoteId: string): Promise<ActionResult<QuoteWithItems>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_quotes")
    .select(QUOTE_SELECT)
    .eq("company_id", profile.company_id)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    logQueryFailure("getQuote", error);
    return internalFailure("getQuote", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");

  const cabecalho = data as unknown as Omit<QuoteRow, "target_name">;

  const { data: itens, error: erroItens } = await admin
    .from("crm_quote_items")
    .select(ITEM_SELECT)
    .eq("company_id", profile.company_id)
    .eq("quote_id", quoteId)
    .order("position", { ascending: true });

  if (erroItens) {
    logQueryFailure("getQuote:itens", erroItens);
    return internalFailure("getQuote", erroItens, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const nomes = await nomesDosDestinatarios(admin, profile.company_id, [cabecalho]);

  return actionSuccess({
    quote: {
      ...cabecalho,
      target_name: nomes.get((cabecalho.lead_id ?? cabecalho.client_id) as string) ?? "—",
    },
    items: (itens ?? []) as unknown as QuoteItemRow[],
  });
}

// ── Escritas (RPC, e só RPC) ────────────────────────────────────────────────

const itemSchema = z.object({
  description: z.string().trim().min(1, "Escreva o que está a orçamentar.").max(500),
  quantity: z.number().positive("A quantidade tem de ser maior do que zero.").max(100_000),
  unit: z.enum(QUOTE_UNITS),
  unitPrice: z.number().min(0, "O preço não pode ser negativo.").max(1_000_000),
});

const criarSchema = z
  .object({
    leadId: z.uuid().optional().nullable(),
    clientId: z.uuid().optional().nullable(),
    visitId: z.uuid().optional().nullable(),
    issueDate: z.iso.date(),
    validUntil: z.iso.date(),
    pricingKind: z.enum(QUOTE_PRICING_KINDS),
    discountPct: z.number().min(0).max(100).optional().nullable(),
    applyVat: z.boolean().optional().nullable(),
    proposedFrequency: z.string().trim().max(50).optional().nullable(),
    paymentTerms: z.string().trim().max(500).optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    internalNotes: z.string().trim().max(5000).optional().nullable(),
    items: z.array(itemSchema).min(1, "Um orçamento tem de ter pelo menos uma linha.").max(100),
  })
  // As duas regras que a base também impõe. Aqui produzem uma mensagem que se
  // entende; lá, uma violação de restrição.
  .refine((v) => Boolean(v.leadId) !== Boolean(v.clientId), {
    message: "O orçamento é para uma lead ou para um cliente — escolha um.",
    path: ["leadId"],
  })
  .refine((v) => v.validUntil >= v.issueDate, {
    message: "A validade não pode ser anterior à data de emissão.",
    path: ["validUntil"],
  });

export type CriarOrcamentoInput = z.input<typeof criarSchema>;

/**
 * Cria um orçamento — cabeçalho, linhas e número, numa só transação.
 *
 * 🔴 `p_vat_rate` e `p_prefix` vêm de `company_settings` LIDOS AQUI, e o erro
 *    da leitura conta. Cair num `?? 23` orçamentaria com uma taxa que pode não
 *    ser a da empresa, e um IVA errado num documento que vai para um cliente
 *    não é um detalhe recuperável.
 *
 *    A taxa é copiada para a linha do orçamento de propósito (instantâneo, e
 *    não referência): mudar o IVA nas definições não pode alterar o total de
 *    um orçamento que já saiu.
 */
export async function createQuote(
  input: CriarOrcamentoInput,
): Promise<ActionResult<{ id: string; quoteNumber: string }>> {
  const parsed = criarSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const d = parsed.data;

  const { data: settings, error: erroSettings } = await admin
    .from("company_settings")
    .select("vat_rate, quote_prefix")
    .eq("company_id", profile.company_id)
    .maybeSingle();

  if (erroSettings) {
    logQueryFailure("createQuote:settings", erroSettings);
    return internalFailure("createQuote", erroSettings, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!settings) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "As definições da empresa não foram encontradas. Não é possível orçamentar sem a taxa de IVA.",
    );
  }

  // O destinatário tem de ser desta empresa. As FKs compostas da 103 também o
  // garantem, mas aqui a resposta é «não encontrado» em vez de um erro de
  // restrição que ninguém sabe ler.
  if (d.leadId) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("id")
      .eq("company_id", profile.company_id)
      .eq("id", d.leadId)
      .maybeSingle();
    if (!lead) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");
  }
  if (d.clientId) {
    const { data: cliente } = await admin
      .from("clients")
      .select("id")
      .eq("company_id", profile.company_id)
      .eq("id", d.clientId)
      .maybeSingle();
    if (!cliente) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Cliente não encontrado.");
  }

  // 🔴 O ano do NÚMERO é o ano da data de emissão, e não `new Date()`. Emitir
  //    a 2 de Janeiro um orçamento datado de 31 de Dezembro tem de ir para a
  //    série do ano anterior — é dela que o sequencial vem.
  const ano = Number(d.issueDate.slice(0, 4));

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("create_crm_quote_with_items", {
      p_company_id: profile.company_id,
      p_lead_id: d.leadId ?? null,
      p_client_id: d.clientId ?? null,
      p_visit_id: d.visitId ?? null,
      p_prefix: settings.quote_prefix,
      p_year: ano,
      p_issue_date: d.issueDate,
      p_valid_until: d.validUntil,
      p_pricing_kind: d.pricingKind,
      p_discount_pct: d.discountPct ?? 0,
      p_apply_vat: d.applyVat ?? true,
      p_vat_rate: settings.vat_rate,
      p_proposed_frequency: d.proposedFrequency ?? null,
      // 🔴 `proposed_weekdays` fica a NULL neste ciclo: os dias propostos
      //    servem para pré-preencher o contrato na conversão, que é a 104. Um
      //    campo preenchido que nada lê seria informação a envelhecer.
      p_proposed_weekdays: null,
      p_payment_terms: d.paymentTerms ?? null,
      p_notes: d.notes ?? null,
      p_internal_notes: d.internalNotes ?? null,
      p_actor: profile.id,
      p_items: d.items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unitPrice,
      })),
    });

    if (error) return erroDaRpc("createQuote", error.message);

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.quote_id) {
      return internalFailure(
        "createQuote",
        new Error("a RPC não devolveu o orçamento criado"),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    // A proveniência: o orçamento entra na história da lead de onde nasceu.
    if (d.leadId) {
      await registarNaLead(admin, profile.company_id, d.leadId, profile.id,
        `Orçamento ${linha.quote_number} criado.`);
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_created",
      entityType: "crm_quote",
      entityId: String(linha.quote_id),
      after: { quote_number: linha.quote_number, itens: d.items.length },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    return actionSuccess({ id: String(linha.quote_id), quoteNumber: String(linha.quote_number) });
  } catch (err) {
    return internalFailure("createQuote", err, ACTION_ERROR_CODES.PERSISTENCE);
  }
}

const revisaoSchema = z
  .object({
    issueDate: z.iso.date(),
    validUntil: z.iso.date(),
    discountPct: z.number().min(0).max(100).optional().nullable(),
    applyVat: z.boolean().optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    items: z.array(itemSchema).min(1, "Uma revisão tem de ter pelo menos uma linha.").max(100),
  })
  .refine((v) => v.validUntil >= v.issueDate, {
    message: "A validade não pode ser anterior à data de emissão.",
    path: ["validUntil"],
  });

export type RevisaoOrcamentoInput = z.input<typeof revisaoSchema>;

/**
 * Revê um orçamento que já saiu — a R(n+1).
 *
 * O que a RPC faz, e que nenhuma sequência de chamadas daqui faria em
 * segurança: marca a antiga como substituída ANTES de inserir a nova, dentro
 * da mesma transação, para que o índice parcial de «revisão viva» nunca veja
 * duas ao mesmo tempo. A FK `superseded_by_id` é DEFERRABLE justamente para
 * isso.
 *
 * O resultado é o que a direcção espera ver:
 *
 *     R0 enviada → revisão → R1 rascunho, R0 substituída (histórica)
 *
 * 🔴 A nova nasce em `rascunho`. Não herda o `enviado` da anterior, porque
 *    ainda não foi enviada a ninguém.
 */
export async function reviseQuote(
  quoteId: string,
  input: RevisaoOrcamentoInput,
): Promise<ActionResult<{ id: string; quoteNumber: string }>> {
  const parsed = revisaoSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  if (!z.uuid().safeParse(quoteId).success) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const d = parsed.data;

  // A taxa de IVA da revisão é a das definições no momento da revisão: é um
  // documento novo, com data nova, e é essa a taxa que lhe corresponde.
  const { data: settings, error: erroSettings } = await admin
    .from("company_settings")
    .select("vat_rate")
    .eq("company_id", profile.company_id)
    .maybeSingle();

  if (erroSettings) {
    logQueryFailure("reviseQuote:settings", erroSettings);
    return internalFailure("reviseQuote", erroSettings, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!settings) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "As definições da empresa não foram encontradas. Não é possível revir sem a taxa de IVA.",
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("revise_crm_quote", {
      p_company_id: profile.company_id,
      p_quote_id: quoteId,
      p_actor: profile.id,
      p_issue_date: d.issueDate,
      p_valid_until: d.validUntil,
      p_discount_pct: d.discountPct ?? 0,
      p_apply_vat: d.applyVat ?? true,
      p_vat_rate: settings.vat_rate,
      p_notes: d.notes ?? null,
      p_items: d.items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unitPrice,
      })),
    });

    if (error) return erroDaRpc("reviseQuote", error.message);

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.quote_id) {
      return internalFailure(
        "reviseQuote",
        new Error("a RPC não devolveu a revisão criada"),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_revised",
      entityType: "crm_quote",
      entityId: String(linha.quote_id),
      before: { substituiu: quoteId },
      after: { quote_number: linha.quote_number },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    return actionSuccess({ id: String(linha.quote_id), quoteNumber: String(linha.quote_number) });
  } catch (err) {
    return internalFailure("reviseQuote", err, ACTION_ERROR_CODES.PERSISTENCE);
  }
}

const estadoSchema = z.object({
  // 🔴 A lista completa, e não só os destinos «seguros»: a matriz de
  //    transições vive na RPC, que é onde a decisão se toma sob `FOR UPDATE`.
  //    Duplicá-la aqui como validação daria dois sítios a discordar.
  status: z.enum(QUOTE_STATUSES),
  reason: z.string().trim().max(500).optional().nullable(),
});

/**
 * Muda o estado de um orçamento.
 *
 * 🔴 Inclui `rascunho → enviado`, MANUALMENTE. O envio automático por email é
 *    a 103-B2; até lá o orçamento sai por PDF, por mão, e quem o mandou tem de
 *    o poder registar. Sem isto um orçamento entregue ficava eternamente
 *    «rascunho» — e um estado que não corresponde à realidade é pior do que
 *    não ter estado.
 *
 * A transição é decidida pela base, dentro da RPC, sob `FOR UPDATE`. Não se
 * lê o estado aqui para depois gravar: dois gestores a mudar o mesmo
 * orçamento ao mesmo tempo, e a segunda escrita ganhava em silêncio.
 */
export async function setQuoteStatus(
  quoteId: string,
  input: z.input<typeof estadoSchema>,
): Promise<ActionResult<{ status: QuoteStatus }>> {
  const parsed = estadoSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  if (!z.uuid().safeParse(quoteId).success) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("set_crm_quote_status", {
      p_company_id: profile.company_id,
      p_quote_id: quoteId,
      p_actor: profile.id,
      p_status: parsed.data.status,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) return erroDaRpc("setQuoteStatus", error.message);

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.status) {
      return internalFailure(
        "setQuoteStatus",
        new Error("a RPC não devolveu o estado"),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_status",
      entityType: "crm_quote",
      entityId: quoteId,
      after: { status: linha.status, reason: parsed.data.reason ?? null },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    return actionSuccess({ status: linha.status as QuoteStatus });
  } catch (err) {
    return internalFailure("setQuoteStatus", err, ACTION_ERROR_CODES.PERSISTENCE);
  }
}

// ── Interno ─────────────────────────────────────────────────────────────────

/**
 * Escreve na timeline da lead sem deixar que uma falha aqui parta o orçamento.
 *
 * 🔴 `crm_lead_interactions` é uma PROJEÇÃO DERIVADA, best-effort — a mesma
 *    decisão que `crm-visitas.ts` já tomou, e pela mesma razão. A fonte
 *    autoritativa de um orçamento é `crm_quotes`, e só ela.
 *
 *    A consequência tem de ser dita em voz alta: o diário pode ter buracos.
 *    NENHUM relatório pode contar orçamentos a partir desta tabela.
 */
async function registarNaLead(
  admin: AdminClient,
  companyId: string,
  leadId: string,
  authorId: string,
  summary: string,
): Promise<void> {
  try {
    const { error } = await admin.from("crm_lead_interactions").insert({
      company_id: companyId,
      lead_id: leadId,
      kind: "sistema",
      summary,
      author_id: authorId,
    });
    if (error) logQueryFailure("registarNaLead", error);
  } catch (err) {
    console.error("[registarNaLead] falhou:", err);
  }
}
