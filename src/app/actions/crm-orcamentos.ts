"use server";

// ============================================================================
// CRM — orçamentos
// ============================================================================
//
// 🔴 Só funções assíncronas. O vocabulário vive em `src/lib/crm/quotes.ts`.
//
// 🔴 Toda a escrita passa pelas RPC da migration 103. Nenhuma destas funções
//    faz `ler → decidir → escrever` em passos separados: a numeração, os
//    totais e as transições de estado são decididos dentro da transação, que é
//    o que impede dois orçamentos com o mesmo número e um total que não
//    corresponde às linhas.
//
// 🔴 Um orçamento NÃO é um documento fiscal. Este ficheiro não toca em
//    `invoices`, `cash_flow_entries`, `services` nem `contracts`.
// ============================================================================

import { z } from "zod";

import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  validationFailure,
  type ActionResult,
} from "@/lib/action-result";
import { AUTH_GUARD_CODES, requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";
import { logQueryFailure } from "@/lib/query-error";
import { todayInLisbon, addDaysToDateString } from "@/lib/lisbon-time";
import { getResend, FROM_EMAIL } from "@/lib/email";
import { quoteEmailTemplate } from "@/lib/email/templates";
import {
  QUOTE_STATUSES,
  QUOTE_UNITS,
  QUOTE_PRICING_KINDS,
  QUOTE_DEFAULT_VALIDITY_DAYS,
} from "@/lib/crm/quotes";

export interface QuoteItemRow {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
}

export interface QuoteRow {
  id: string;
  lead_id: string | null;
  client_id: string | null;
  visit_id: string | null;
  target_name: string;
  quote_number: string;
  revision: number;
  root_quote_id: string;
  superseded_by_id: string | null;
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
  payment_terms: string | null;
  notes: string | null;
  internal_notes: string | null;
  converted_contract_id: string | null;
  items?: QuoteItemRow[];
}

const QUOTE_SELECT = `
  id, lead_id, client_id, visit_id, quote_number, revision, root_quote_id,
  superseded_by_id, issue_date, valid_until, status,
  sent_at, accepted_at, rejected_at, rejection_reason,
  pricing_kind, subtotal, discount_pct, apply_vat, vat_rate, vat_amount, total,
  proposed_frequency, payment_terms, notes, internal_notes, converted_contract_id
`;

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
 * Traduz os erros que as RPC levantam para mensagens que se entendem.
 *
 * 🔴 Ramifica pelo código que a RPC escolheu, nunca pelo texto do Postgres:
 *    a mensagem é para ler, o código é para decidir. E nenhum nome de tabela
 *    ou restrição chega ao ecrã.
 */
function erroDaRpc(contexto: string, err: unknown): ActionResult<never> {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("QUOTE_ACCEPTED_IMMUTABLE")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Este orçamento já foi aceite e não pode ser alterado. Para mudar os valores, emita um orçamento novo.",
    );
  }
  if (msg.includes("QUOTE_VOIDED_IMMUTABLE")) {
    return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, "Este orçamento foi anulado.");
  }
  if (msg.includes("QUOTE_ALREADY_SUPERSEDED")) {
    return actionFailure(
      ACTION_ERROR_CODES.CONFLICT,
      "Já existe uma revisão mais recente deste orçamento. Abra-a para trabalhar sobre ela.",
    );
  }
  if (msg.includes("QUOTE_DRAFT_EDIT_IN_PLACE")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Um rascunho edita-se diretamente — não precisa de revisão.",
    );
  }
  if (msg.includes("QUOTE_EXPIRED_CANNOT_ACCEPT")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "A validade deste orçamento já passou. Reveja-o com uma data nova antes de o dar como aceite.",
    );
  }
  if (msg.includes("QUOTE_ALREADY_SUPERSEDED")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Este orçamento foi substituído por uma revisão mais recente. Trabalhe sobre a revisão em vigor — esta fica como histórico.",
    );
  }
  if (msg.includes("QUOTE_TRANSITION_NOT_ALLOWED")) {
    return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, "Essa mudança de estado não é possível.");
  }
  if (msg.includes("QUOTE_NOT_FOUND")) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }
  if (msg.includes("sem linhas")) {
    return actionFailure(
      ACTION_ERROR_CODES.VALIDATION,
      "Um orçamento tem de ter pelo menos uma linha.",
    );
  }

  return internalFailure(contexto, err, ACTION_ERROR_CODES.PERSISTENCE);
}

// ── Validação ───────────────────────────────────────────────────────────────

const linhaSchema = z.object({
  description: z.string().trim().min(1, "A linha precisa de descrição.").max(500),
  quantity: z.number().positive("A quantidade tem de ser maior que zero.").max(1_000_000),
  unit: z.enum(QUOTE_UNITS).default("servico"),
  unit_price: z.number().min(0, "O preço não pode ser negativo.").max(1_000_000),
});

const orcamentoSchema = z.object({
  leadId: z.uuid().optional().nullable(),
  clientId: z.uuid().optional().nullable(),
  visitId: z.uuid().optional().nullable(),
  issueDate: z.iso.date(),
  validUntil: z.iso.date(),
  pricingKind: z.enum(QUOTE_PRICING_KINDS).default("pontual"),
  discountPct: z.number().min(0).max(100).default(0),
  applyVat: z.boolean().default(true),
  proposedFrequency: z.string().trim().max(200).optional().nullable(),
  paymentTerms: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  internalNotes: z.string().trim().max(5000).optional().nullable(),
  items: z.array(linhaSchema).min(1, "Um orçamento tem de ter pelo menos uma linha.").max(100),
}).refine((v) => Boolean(v.leadId) !== Boolean(v.clientId), {
  message: "O orçamento é para uma lead ou para um cliente — escolha um.",
  path: ["leadId"],
}).refine((v) => v.validUntil >= v.issueDate, {
  message: "A validade não pode ser anterior à data do orçamento.",
  path: ["validUntil"],
});

export type OrcamentoInput = z.input<typeof orcamentoSchema>;

/**
 * A taxa de IVA e o prefixo, lidos das configurações da empresa.
 *
 * 🔴 NÃO assume 23% quando a leitura falha, e a razão é mais forte aqui do que
 *    num relatório: a taxa é COPIADA para o orçamento e fica lá para sempre.
 *    Um `?? 23` transformaria uma consulta falhada num documento que diz, a um
 *    cliente, que a taxa da empresa é 23% — indistinguível de uma taxa
 *    realmente configurada, e impossível de detectar depois.
 *
 *    Sem configurações legíveis, não se emite o documento.
 */
async function lerConfiguracoes(
  admin: NonNullable<AdminClient>,
  companyId: string,
): Promise<{ ok: true; prefixo: string; taxaIva: number } | { ok: false }> {
  const { data, error } = await admin
    .from("company_settings")
    .select("quote_prefix, vat_rate")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    logQueryFailure("lerConfiguracoes", error);
    return { ok: false };
  }

  const linha = data as { quote_prefix?: string; vat_rate?: number } | null;
  // Uma falha não é uma lista vazia, e a ausência de linha não é zero.
  if (!linha || typeof linha.vat_rate !== "number") return { ok: false };

  return {
    ok: true,
    // O prefixo tem um valor por omissão na base (`DEFAULT 'ORC'`), por isso
    // aqui só se protege contra a coluna vir vazia por outra razão.
    prefixo: linha.quote_prefix || "ORC",
    taxaIva: linha.vat_rate,
  };
}

const SEM_CONFIGURACOES =
  "Não foi possível ler o IVA configurado para a empresa. Verifique as Configurações antes de emitir o orçamento.";

// ── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Os orçamentos.
 *
 * 🔴 Por omissão devolve só as revisões vivas (`superseded_by_id IS NULL`).
 *    Sem esse filtro, a lista mostraria a R0 e a R1 do mesmo documento lado a
 *    lado, e ninguém saberia qual é a que vale.
 */
export async function getQuotes(opts?: {
  leadId?: string;
  incluirSubstituidas?: boolean;
}): Promise<ActionResult<QuoteRow[]>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  let query = admin
    .from("crm_quotes")
    .select(QUOTE_SELECT)
    .eq("company_id", profile.company_id);

  if (!opts?.incluirSubstituidas) query = query.is("superseded_by_id", null);
  // 🔴 `source_lead_id`, não `lead_id`.
  //
  //    A conversão põe `lead_id` a NULL (o destinatário passa a ser o cliente),
  //    e enquanto este filtro olhava para `lead_id` a ficha da lead deixava de
  //    mostrar precisamente o orçamento que fechou o negócio — o único que
  //    interessa ver lá. `source_lead_id` é imutável, por isso a lista continua
  //    completa depois da conversão.
  //
  //    O `or` mantém os orçamentos anteriores à coluna existir, cuja
  //    proveniência só está em `lead_id`.
  if (opts?.leadId) {
    // 🔴 `.or()` constrói uma expressão de filtro em TEXTO. Interpolar aqui um
    //    valor não validado seria injeção no PostgREST — os outros filtros usam
    //    `.eq()`, que vai parametrizado, e por isso não tinham este problema.
    const leadIdValido = z.uuid().safeParse(opts.leadId);
    if (!leadIdValido.success) return validationFailure(leadIdValido.error);

    query = query.or(
      `source_lead_id.eq.${leadIdValido.data},lead_id.eq.${leadIdValido.data}`,
    );
  }

  const { data, error } = await query
    .order("quote_year", { ascending: false })
    .order("quote_seq", { ascending: false });

  if (error) {
    logQueryFailure("getQuotes", error);
    return internalFailure("getQuotes", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const linhas = (data ?? []) as unknown as Omit<QuoteRow, "target_name">[];
  const nomes = await resolverNomes(admin, profile.company_id, linhas);

  return actionSuccess(
    linhas.map((q) => ({
      ...q,
      target_name: nomes.get((q.lead_id ?? q.client_id) as string) ?? "—",
    })),
  );
}

/** Um orçamento com as suas linhas. */
export async function getQuote(quoteId: string): Promise<ActionResult<QuoteRow>> {
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

  const quote = data as unknown as Omit<QuoteRow, "target_name">;

  const { data: itens, error: erroItens } = await admin
    .from("crm_quote_items")
    .select("id, position, description, quantity, unit, unit_price, line_total")
    .eq("company_id", profile.company_id)
    .eq("quote_id", quoteId)
    .order("position", { ascending: true });

  if (erroItens) {
    logQueryFailure("getQuote.items", erroItens);
    return internalFailure("getQuote.items", erroItens, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const nomes = await resolverNomes(admin, profile.company_id, [quote]);

  return actionSuccess({
    ...quote,
    target_name: nomes.get((quote.lead_id ?? quote.client_id) as string) ?? "—",
    items: (itens ?? []) as unknown as QuoteItemRow[],
  });
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export async function createQuote(
  input: OrcamentoInput,
): Promise<ActionResult<{ id: string; number: string }>> {
  const parsed = orcamentoSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const d = parsed.data;

  // O prefixo e a taxa de IVA vêm das configurações da empresa, e o IVA é
  // copiado para o orçamento: mudá-lo depois nas definições não pode alterar
  // o total de um documento já enviado.
  const conf = await lerConfiguracoes(admin, profile.company_id);
  if (!conf.ok) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, SEM_CONFIGURACOES);
  const { prefixo, taxaIva } = conf;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("create_crm_quote_with_items", {
      p_company_id: profile.company_id,
      p_lead_id: d.leadId ?? null,
      p_client_id: d.clientId ?? null,
      p_visit_id: d.visitId ?? null,
      p_prefix: prefixo,
      p_year: Number(d.issueDate.slice(0, 4)),
      p_issue_date: d.issueDate,
      p_valid_until: d.validUntil,
      p_pricing_kind: d.pricingKind,
      p_discount_pct: d.discountPct,
      p_apply_vat: d.applyVat,
      p_vat_rate: taxaIva,
      p_proposed_frequency: d.proposedFrequency ?? null,
      p_proposed_weekdays: null,
      p_payment_terms: d.paymentTerms ?? null,
      p_notes: d.notes ?? null,
      p_internal_notes: d.internalNotes ?? null,
      p_actor: profile.id,
      p_items: d.items,
    });

    if (error) return erroDaRpc("createQuote", new Error(error.message));

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.quote_id) {
      return internalFailure("createQuote", new Error("RPC sem resultado"), ACTION_ERROR_CODES.PERSISTENCE);
    }

    if (d.leadId) {
      await registarNaLead(admin, profile.company_id, d.leadId, profile.id,
        `Orçamento ${linha.quote_number} criado.`);
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_created",
      entityType: "crm_quote",
      entityId: linha.quote_id,
      after: { number: linha.quote_number, items: d.items.length },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    return actionSuccess({ id: linha.quote_id as string, number: linha.quote_number as string });
  } catch (err) {
    return erroDaRpc("createQuote", err);
  }
}

/**
 * Cria a revisão de um orçamento já enviado.
 *
 * Um rascunho não passa por aqui: edita-se em cima, e a RPC recusa com
 * `QUOTE_DRAFT_EDIT_IN_PLACE`.
 */
export async function reviseQuote(
  quoteId: string,
  input: {
    issueDate: string;
    validUntil: string;
    discountPct: number;
    applyVat: boolean;
    notes?: string | null;
    items: z.input<typeof linhaSchema>[];
  },
): Promise<ActionResult<{ id: string; number: string }>> {
  const parsed = z
    .object({
      issueDate: z.iso.date(),
      validUntil: z.iso.date(),
      discountPct: z.number().min(0).max(100),
      applyVat: z.boolean(),
      notes: z.string().trim().max(5000).optional().nullable(),
      items: z.array(linhaSchema).min(1).max(100),
    })
    .refine((v) => v.validUntil >= v.issueDate, {
      message: "A validade não pode ser anterior à data do orçamento.",
      path: ["validUntil"],
    })
    .safeParse(input);

  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const conf = await lerConfiguracoes(admin, profile.company_id);
  if (!conf.ok) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, SEM_CONFIGURACOES);
  const taxaIva = conf.taxaIva;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("revise_crm_quote", {
      p_company_id: profile.company_id,
      p_quote_id: quoteId,
      p_actor: profile.id,
      p_issue_date: parsed.data.issueDate,
      p_valid_until: parsed.data.validUntil,
      p_discount_pct: parsed.data.discountPct,
      p_apply_vat: parsed.data.applyVat,
      p_vat_rate: taxaIva,
      p_notes: parsed.data.notes ?? null,
      p_items: parsed.data.items,
    });

    if (error) return erroDaRpc("reviseQuote", new Error(error.message));

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.quote_id) {
      return internalFailure("reviseQuote", new Error("RPC sem resultado"), ACTION_ERROR_CODES.PERSISTENCE);
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_revised",
      entityType: "crm_quote",
      entityId: linha.quote_id,
      before: { revised_from: quoteId },
      after: { number: linha.quote_number },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    return actionSuccess({ id: linha.quote_id as string, number: linha.quote_number as string });
  } catch (err) {
    return erroDaRpc("reviseQuote", err);
  }
}

export async function setQuoteStatus(
  quoteId: string,
  input: { status: string; reason?: string | null },
): Promise<ActionResult<{ status: string }>> {
  const parsed = z
    .object({
      status: z.enum(QUOTE_STATUSES),
      reason: z.string().trim().max(1000).optional().nullable(),
    })
    .safeParse(input);

  if (!parsed.success) return validationFailure(parsed.error);

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

    if (error) return erroDaRpc("setQuoteStatus", new Error(error.message));

    // A timeline da lead: quem abrir a ficha vê o que aconteceu ao orçamento
    // sem ter de ir à lista de orçamentos.
    const { data: q } = await admin
      .from("crm_quotes")
      .select("lead_id, quote_number")
      .eq("company_id", profile.company_id)
      .eq("id", quoteId)
      .maybeSingle();

    if (q?.lead_id) {
      await registarNaLead(admin, profile.company_id, q.lead_id, profile.id,
        `Orçamento ${q.quote_number}: ${parsed.data.status}.`);
    }

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "crm_quote_status",
      entityType: "crm_quote",
      entityId: quoteId,
      after: { status: parsed.data.status },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });
    const linha = Array.isArray(data) ? data[0] : data;
    return actionSuccess({ status: (linha?.status as string) ?? parsed.data.status });
  } catch (err) {
    return erroDaRpc("setQuoteStatus", err);
  }
}

/** A data de validade sugerida para um orçamento novo. */
export async function suggestQuoteDates(): Promise<
  ActionResult<{ issueDate: string; validUntil: string; vatRate: number }>
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const conf = await lerConfiguracoes(admin, profile.company_id);
  if (!conf.ok) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, SEM_CONFIGURACOES);

  // 🔴 `todayInLisbon()`, nunca `new Date()`: o processo corre em UTC na
  //    Vercel, e a validade de um orçamento é precisamente onde a diferença
  //    de um dia se nota.
  const hoje = todayInLisbon();

  return actionSuccess({
    issueDate: hoje,
    validUntil: addDaysToDateString(hoje, QUOTE_DEFAULT_VALIDITY_DAYS),
    vatRate: conf.taxaIva,
  });
}


// ── Envio por email ─────────────────────────────────────────────────────────

const envioSchema = z.object({
  to: z.email("Email inválido."),
  customMessage: z.string().trim().max(2000).optional().nullable(),
  /**
   * O PDF, em base64, gerado no cliente.
   *
   * 🔴 Porque é que o PDF vem do browser e não é gerado aqui: `jspdf` depende
   *    de `window` e não corre no servidor. Mais importante do que isso — o
   *    documento que se envia tem de ser **exactamente** o que o gestor viu no
   *    ecrã antes de carregar em enviar. Gerá-lo outra vez aqui abriria a
   *    hipótese de enviar um documento diferente do que foi revisto.
   *
   *    O conteúdo não é dado de confiança: é um anexo, nunca é interpretado, e
   *    o limite de tamanho abaixo impede que sirva de canal para outra coisa.
   */
  pdfBase64: z.string().min(1).max(8_000_000, "O PDF é demasiado grande."),
});

export async function sendQuoteByEmail(
  quoteId: string,
  input: z.input<typeof envioSchema>,
): Promise<ActionResult<{ sent: true }>> {
  const parsed = envioSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data: quote, error } = await admin
    .from("crm_quotes")
    .select("id, lead_id, quote_number, total, valid_until, status, superseded_by_id")
    .eq("company_id", profile.company_id)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    logQueryFailure("sendQuoteByEmail", error);
    return internalFailure("sendQuoteByEmail", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!quote) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");

  // 🔴 Uma revisão substituída não volta a circular — e a recusa tem de
  //    acontecer ANTES do Resend.
  //
  //    Este é o único dos três guardas de `superseded` que não pode viver só na
  //    base: quando a RPC de estado recusasse, o email já tinha saído. Um
  //    documento enviado não se desenvia, e o cliente ficaria com dois PDFs com
  //    preços diferentes e nenhuma indicação de qual vale.
  //
  //    A verificação é uma leitura e pode ficar velha entre o SELECT e o envio.
  //    Não é o controlo de concorrência da cadeia de revisões — esse está na
  //    base, em `revise_crm_quote` e no índice parcial. É o que impede o efeito
  //    externo e irreversível no caso normal, que é onde ele acontece.
  if (quote.superseded_by_id) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Este orçamento foi substituído por uma revisão mais recente. Envie a revisão em vigor.",
    );
  }

  // 🔴 Um orçamento aceite ou anulado não se reenvia: o primeiro já produziu um
  //    acordo, o segundo acabou. Reenviar qualquer um deles poria em circulação
  //    um documento que já não representa o que está combinado.
  if (quote.status === "aceite" || quote.status === "anulado") {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      quote.status === "aceite"
        ? "Este orçamento já foi aceite — não faz sentido reenviá-lo."
        : "Este orçamento foi anulado.",
    );
  }

  const nomes = await resolverNomes(admin, profile.company_id, [
    { lead_id: quote.lead_id, client_id: null },
  ]);

  try {
    const resend = getResend();
    const { subject, html } = quoteEmailTemplate({
      clientName: nomes.get(quote.lead_id as string) ?? "Cliente",
      quoteNumber: quote.quote_number,
      total: Number(quote.total),
      validUntil: quote.valid_until,
      companyPhone: process.env.COMPANY_PHONE ?? "925 780 509",
      customMessage: parsed.data.customMessage ?? null,
    });

    const { error: erroEnvio } = await resend.emails.send({
      from: FROM_EMAIL,
      to: parsed.data.to,
      subject,
      html,
      attachments: [
        {
          filename: `${quote.quote_number.replace("/", "-")}.pdf`,
          content: parsed.data.pdfBase64,
        },
      ],
    });

    if (erroEnvio) {
      // O domínio por verificar é a causa mais comum, e a mensagem do Resend
      // não o diz de forma útil a quem está no ecrã.
      const dica = (erroEnvio.message ?? "").toLowerCase().includes("domain")
        ? " Verifique se o domínio de envio está confirmado no Resend."
        : "";
      logQueryFailure("sendQuoteByEmail.resend", { message: erroEnvio.message });
      return actionFailure(
        ACTION_ERROR_CODES.INTERNAL,
        `Não foi possível enviar o email.${dica}`,
      );
    }
  } catch (err) {
    return internalFailure("sendQuoteByEmail", err, ACTION_ERROR_CODES.INTERNAL);
  }

  // 🔴 O estado só muda DEPOIS de o email sair. Marcá-lo antes deixaria um
  //    orçamento "enviado" que ninguém recebeu — e ninguém saberia que tinha
  //    de o reenviar.
  //
  //    Se a RPC falhar aqui, o email já foi: o pior caso é um orçamento em
  //    rascunho que o cliente recebeu. É recuperável (marca-se à mão); o
  //    inverso não é.
  if (quote.status === "rascunho") {
    const res = await setQuoteStatus(quoteId, { status: "enviado" });
    if (!res.ok) return res;
  }

  if (quote.lead_id) {
    await registarNaLead(admin, profile.company_id, quote.lead_id, profile.id,
      `Orçamento ${quote.quote_number} enviado para ${parsed.data.to}.`);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_quote_sent",
    entityType: "crm_quote",
    entityId: quoteId,
    after: { to: parsed.data.to, number: quote.quote_number },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ sent: true as const });
}

// ── Interno ─────────────────────────────────────────────────────────────────

type AdminClient = Parameters<typeof auditLog>[1] extends infer A | undefined ? A : never;

/** Os nomes das leads e dos clientes referidos por um conjunto de orçamentos. */
async function resolverNomes(
  admin: NonNullable<AdminClient>,
  companyId: string,
  linhas: readonly { lead_id: string | null; client_id: string | null }[],
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

/**
 * Escreve na timeline sem deixar que uma falha aqui parta a operação.
 *
 * ── 🔴 DECISÃO EXPLÍCITA: para eventos de ORÇAMENTO, esta timeline é
 *    DERIVED / BEST_EFFORT, e não histórico autoritativo. ───────────────────
 *
 * A pergunta que isto responde é: se este INSERT falhar, perdeu-se um facto?
 * Para orçamentos, não. Tudo o que estas linhas contam está gravado, de forma
 * autoritativa e atomicamente, em `crm_quotes`:
 *
 *   · que foi emitido, quando e por quem → `issue_date`, `created_by`
 *   · que foi enviado e quando           → `status`, `sent_at`
 *   · que foi aceite ou recusado, quando → `accepted_at`, `rejected_at`,
 *                                          `rejection_reason`
 *   · que foi revisto, e por qual        → `revision`, `root_quote_id`,
 *                                          `superseded_by_id`
 *
 * Essas colunas são escritas DENTRO das RPC, na mesma transação da mutação que
 * descrevem. A timeline é uma projeção legível delas — um buraco aqui custa uma
 * linha num ecrã, não um facto.
 *
 * 🔴 Isto NÃO vale para os eventos de ESTADO DA LEAD. Esses são escritos dentro
 *    de `move_crm_lead_stage_atomic` (101) e de `convert_crm_lead_atomic` (104),
 *    na mesma transação, precisamente porque aí a timeline É a única prova de
 *    porquê e quando o cartão mudou de coluna — não há outra coluna que o diga.
 *    A diferença entre os dois casos é essa, e é a razão de um ser best-effort
 *    e o outro não.
 *
 * Consequência a respeitar: nenhum ecrã, relatório ou export pode apresentar
 * `crm_lead_interactions` como histórico COMPLETO de orçamentos. Se algum dia
 * for preciso prometer isso, este INSERT tem de passar para dentro das RPC de
 * orçamento — não basta acrescentar-lhe um retry.
 */
async function registarNaLead(
  admin: NonNullable<AdminClient>,
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
