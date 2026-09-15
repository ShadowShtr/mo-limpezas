"use server";

// ============================================================================
// CRM — o funil de leads
// ============================================================================
//
// 🔴 Este ficheiro só exporta funções assíncronas. As listas de estados,
//    origens e etiquetas vivem em `src/lib/crm/` — um ficheiro `"use server"`
//    não pode exportar objetos, e a violação dessa regra já bloqueou todas as
//    notificações do calendário uma vez (2026-06-08).
//
// Módulo novo: nasce já no formato `ActionResult<T>` (padrão de engenharia,
// secção 3). Nenhuma destas funções devolve o erro cru do Supabase — nomes de
// tabelas e restrições não chegam ao ecrã.
//
// 🔴 O CRM não escreve em `contracts`, `services`, `invoices` nem
//    `cash_flow_entries`. É essa fronteira que o mantém fora do orçamento de
//    escrita financeira, e é deliberada: uma lead não é dinheiro nem trabalho.
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
import {
  LEAD_SOURCES,
  LEAD_LOST_REASONS,
  LEAD_VALUE_KINDS,
  MANUAL_INTERACTION_KINDS,
} from "@/lib/crm/sources";
// 🔴 `canTransition`, `requiresLostReason` e as etiquetas deixaram de ser
//    usadas aqui: as regras de transição passaram para a RPC
//    `move_crm_lead_stage_atomic`, que é agora a autoridade. Continuam a viver
//    em `src/lib/crm/stages.ts` para a interface só oferecer o que passa — e
//    `crm-quotes-vocabulary.test.ts` compara as duas listas.
import { LEAD_STAGES, type LeadStage } from "@/lib/crm/stages";

// ── A forma que a interface recebe ──────────────────────────────────────────

export interface LeadRow {
  id: string;
  name: string;
  lead_type: "individual" | "empresa";
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  nif: string | null;
  address: string | null;
  stage: string;
  board_order: number;
  source: string | null;
  source_detail: string | null;
  owner_id: string | null;
  owner_name: string | null;
  estimated_value: number | null;
  estimated_value_kind: string;
  next_action_at: string | null;
  next_action_note: string | null;
  service_type: string | null;
  frequency_hint: string | null;
  notes: string | null;
  lost_reason: string | null;
  lost_reason_notes: string | null;
  converted_client_id: string | null;
  created_at: string;
}

export interface LeadInteractionRow {
  id: string;
  kind: string;
  summary: string;
  occurred_at: string;
  author_id: string | null;
  author_name: string | null;
}

/**
 * As colunas que a lista e a ficha precisam, explícitas.
 *
 * Nunca `select("*")`: uma coluna nova passaria a viajar para o cliente sem
 * ninguém decidir que devia — e o `ClienteSheet` já mostrou o que acontece
 * quando um formulário grava um campo que a query não trouxe.
 */
const LEAD_SELECT = `
  id, name, lead_type, contact_name, email, phone, nif, address,
  stage, board_order, source, source_detail, owner_id,
  estimated_value, estimated_value_kind,
  next_action_at, next_action_note,
  service_type, frequency_hint, notes,
  lost_reason, lost_reason_notes, converted_client_id, created_at
`;

// ── Validação ───────────────────────────────────────────────────────────────

const textoOpcional = z
  .string()
  .trim()
  .max(500)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const leadSchema = z.object({
  name: z.string().trim().min(1, "O nome é obrigatório.").max(200),
  lead_type: z.enum(["individual", "empresa"]).default("empresa"),
  contact_name: textoOpcional,
  // Um email vazio é legítimo (muita lead nasce de um telefonema); um email
  // escrito e malformado não é, e passaria despercebido até ao envio falhar.
  email: z
    .union([z.literal(""), z.email("Email inválido.")])
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  phone: textoOpcional,
  nif: textoOpcional,
  address: textoOpcional,
  source: z.enum(LEAD_SOURCES).optional().nullable(),
  source_detail: textoOpcional,
  owner_id: z.uuid().optional().nullable(),
  estimated_value: z
    .number()
    .min(0, "O valor não pode ser negativo.")
    .max(9_999_999)
    .optional()
    .nullable(),
  estimated_value_kind: z.enum(LEAD_VALUE_KINDS).default("mensal"),
  next_action_at: z
    .union([z.literal(""), z.iso.date("Data inválida.")])
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  next_action_note: textoOpcional,
  service_type: textoOpcional,
  frequency_hint: textoOpcional,
  notes: z.string().trim().max(5000).optional().nullable().transform((v) => (v ? v : null)),
});

export type LeadInput = z.input<typeof leadSchema>;

/** Traduz os erros das RPCs do funil para frases que se leem. */
function erroDoFunil(contexto: string, err: unknown): ActionResult<never> {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("LEAD_STAGE_CONFLICT")) {
    return actionFailure(
      ACTION_ERROR_CODES.CONFLICT,
      "Esta lead foi movida entretanto por outra pessoa. Recarregue o quadro para ver onde está.",
    );
  }
  if (msg.includes("LEAD_WIN_REQUIRES_CONVERSION")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Para dar uma lead como ganha, converta-a em cliente a partir do orçamento aceite.",
    );
  }
  if (msg.includes("LEAD_ALREADY_WON")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Esta lead já foi convertida em cliente e não volta ao funil.",
    );
  }
  if (msg.includes("LEAD_LOST_REQUIRES_REASON")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Indique o motivo da perda.",
      { lostReason: ["Escolha um motivo."] },
    );
  }
  if (msg.includes("LEAD_STAGE_UNKNOWN")) {
    return actionFailure(ACTION_ERROR_CODES.VALIDATION, "Esse estado não existe no funil.");
  }
  if (msg.includes("LEAD_NOT_FOUND")) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");
  }
  if (msg.includes("REORDER_INVALID_ITEMS") || msg.includes("REORDER_DUPLICATE_IDS")) {
    return actionFailure(
      ACTION_ERROR_CODES.CONFLICT,
      "O quadro mudou entretanto. Recarregue para ver a ordem actual.",
    );
  }
  if (msg.includes("REORDER_INVALID_POSITION")) {
    return actionFailure(ACTION_ERROR_CODES.VALIDATION, "Posição inválida.");
  }

  return internalFailure(contexto, err, ACTION_ERROR_CODES.PERSISTENCE);
}

/** Traduz a recusa do guard para a mensagem desta área. */
function recusa(code: string): ActionResult<never> {
  if (code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
    return actionFailure(ACTION_ERROR_CODES.UNAUTHENTICATED, "Não autenticado.");
  }
  if (code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Perfil não encontrado.");
  }
  return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para gerir o funil comercial.");
}

// ── Leitura ─────────────────────────────────────────────────────────────────

/**
 * As leads do funil. `incluirFechadas` traz também ganhas e perdidas — o
 * quadro mostra-as, os relatórios também, mas a lista de trabalho não.
 */
export async function getLeads(opts?: {
  incluirArquivadas?: boolean;
}): Promise<ActionResult<LeadRow[]>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  let query = admin
    .from("crm_leads")
    .select(LEAD_SELECT)
    .eq("company_id", profile.company_id);

  if (!opts?.incluirArquivadas) query = query.is("archived_at", null);

  const { data, error } = await query
    .order("board_order", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    logQueryFailure("getLeads", error);
    return internalFailure("getLeads", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const linhas = (data ?? []) as unknown as Omit<LeadRow, "owner_name">[];

  // O nome do responsável numa consulta à parte, e não por join: `profiles` é
  // uma tabela pequena e lida em todo o lado, e um join aqui obrigaria a
  // atravessar a relação com o admin client em cada leitura do quadro.
  const donos = [...new Set(linhas.map((l) => l.owner_id).filter(Boolean))] as string[];
  const nomes = new Map<string, string>();

  if (donos.length > 0) {
    const { data: perfis, error: erroPerfis } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", donos);

    // Um nome em falta não justifica esconder o funil inteiro: a lead aparece
    // sem responsável em vez de a página rebentar.
    if (erroPerfis) logQueryFailure("getLeads.profiles", erroPerfis);
    for (const p of perfis ?? []) nomes.set(p.id, p.full_name);
  }

  return actionSuccess(
    linhas.map((l) => ({ ...l, owner_name: l.owner_id ? nomes.get(l.owner_id) ?? null : null })),
  );
}

/** Uma lead e o seu diário de contactos. */
export async function getLead(
  leadId: string,
): Promise<ActionResult<{ lead: LeadRow; interactions: LeadInteractionRow[] }>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_leads")
    .select(LEAD_SELECT)
    // 🔴 O `company_id` vem da sessão. Sem este filtro, um id adivinhado
    //    devolveria a lead de outra empresa — o admin client não tem RLS.
    .eq("company_id", profile.company_id)
    .eq("id", leadId)
    .maybeSingle();

  if (error) {
    logQueryFailure("getLead", error);
    return internalFailure("getLead", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");

  const lead = data as unknown as Omit<LeadRow, "owner_name">;

  const { data: interacoes, error: erroInteracoes } = await admin
    .from("crm_lead_interactions")
    .select("id, kind, summary, occurred_at, author_id")
    .eq("company_id", profile.company_id)
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false });

  if (erroInteracoes) {
    logQueryFailure("getLead.interactions", erroInteracoes);
    return internalFailure("getLead.interactions", erroInteracoes, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const pessoas = [
    ...new Set([
      lead.owner_id,
      ...(interacoes ?? []).map((i) => i.author_id),
    ].filter(Boolean)),
  ] as string[];

  const nomes = new Map<string, string>();
  if (pessoas.length > 0) {
    const { data: perfis } = await admin.from("profiles").select("id, full_name").in("id", pessoas);
    for (const p of perfis ?? []) nomes.set(p.id, p.full_name);
  }

  return actionSuccess({
    lead: { ...lead, owner_name: lead.owner_id ? nomes.get(lead.owner_id) ?? null : null },
    interactions: (interacoes ?? []).map((i) => ({
      ...i,
      author_name: i.author_id ? nomes.get(i.author_id) ?? null : null,
    })),
  });
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export async function createLead(input: LeadInput): Promise<ActionResult<{ id: string }>> {
  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_leads")
    .insert({
      ...parsed.data,
      company_id: profile.company_id,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    logQueryFailure("createLead", error);
    return internalFailure("createLead", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "lead_created",
    entityType: "crm_lead",
    entityId: data.id,
    after: { name: parsed.data.name, source: parsed.data.source },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: data.id });
}

export async function updateLead(
  leadId: string,
  input: LeadInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_leads")
    .update(parsed.data)
    .eq("company_id", profile.company_id)
    .eq("id", leadId)
    .select("id")
    .maybeSingle();

  if (error) {
    logQueryFailure("updateLead", error);
    return internalFailure("updateLead", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  // Sem linha devolvida, o `id` não existe ou é de outra empresa. As duas
  // respostas são a mesma de propósito: confirmar a existência de uma lead
  // alheia já é informação.
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "lead_updated",
    entityType: "crm_lead",
    entityId: leadId,
    after: { name: parsed.data.name },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: leadId });
}

const moverSchema = z.object({
  stage: z.enum(LEAD_STAGES),
  /**
   * De que coluna o cartão veio, na leitura de quem o arrastou.
   *
   * 🔴 É o controlo de concorrência. Sem ele, duas pessoas a mover o mesmo
   *    cartão dão last-write-wins, e a segunda apaga a decisão da primeira sem
   *    que nenhuma das duas saiba.
   */
  expectedStage: z.enum(LEAD_STAGES).optional().nullable(),
  lostReason: z.enum(LEAD_LOST_REASONS).optional().nullable(),
  lostReasonNotes: z.string().trim().max(1000).optional().nullable(),
});

/**
 * Move a lead no funil.
 *
 * 🔴 Uma chamada de RPC, e mais nada.
 *
 *    A versão anterior fazia `UPDATE` e depois registava a interacção em
 *    best-effort, engolindo o erro. Isso permitia o estado «a lead mudou de
 *    coluna e a timeline não diz porquê» — e a timeline existe precisamente
 *    para responder a isso. Agora as duas escritas são uma transação só, e se
 *    o diário falhar o estado volta atrás com ele.
 *
 * As regras (transição válida, motivo obrigatório na perda, `ganho` só por
 * conversão) vivem na RPC, que é a autoridade. Aqui só se traduzem os códigos
 * de erro para frases que se leem.
 */
export async function moveLeadStage(
  leadId: string,
  input: z.input<typeof moverSchema>,
): Promise<ActionResult<{ stage: LeadStage }>> {
  const parsed = moverSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const destino = parsed.data.stage;

  // Verificação amiga ANTES de chamar a RPC: `ganho` tem um caminho próprio, e
  // uma mensagem que diz o que fazer vale mais do que um código de erro.
  if (destino === "ganho") {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Para dar uma lead como ganha, converta-a em cliente a partir do orçamento aceite.",
    );
  }

  if (destino === "perdido" && !parsed.data.lostReason) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Indique o motivo da perda — é o que permite saber depois porque é que se perde trabalho.",
      { lostReason: ["Escolha um motivo."] },
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("move_crm_lead_stage_atomic", {
      p_company_id: profile.company_id,
      p_lead_id: leadId,
      p_expected_stage: parsed.data.expectedStage ?? null,
      p_new_stage: destino,
      p_actor: profile.id,
      p_lost_reason: parsed.data.lostReason ?? null,
      p_lost_reason_notes: parsed.data.lostReasonNotes ?? null,
    });

    if (error) return erroDoFunil("moveLeadStage", new Error(error.message));

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "lead_stage_changed",
      entityType: "crm_lead",
      entityId: leadId,
      before: { stage: parsed.data.expectedStage ?? null },
      after: { stage: destino, lost_reason: parsed.data.lostReason ?? null },
    }, admin);

    invalidateBusinessState({ domains: ["leads"] });

    const linha = Array.isArray(data) ? data[0] : data;
    return actionSuccess({ stage: (linha?.stage as LeadStage) ?? destino });
  } catch (err) {
    return erroDoFunil("moveLeadStage", err);
  }
}

const ordemSchema = z.object({
  leadId: z.uuid(),
  boardOrder: z.number().int().min(0).max(100_000),
});

/**
 * Guarda a ordem manual dos cartões dentro de uma coluna.
 *
 * 🔴 Uma chamada de RPC, e mais nada.
 *
 *    A versão anterior fazia N `UPDATE` sequenciais. Se o terceiro falhasse,
 *    os dois primeiros ficavam gravados e o quadro ficava numa ordem que
 *    ninguém tinha escolhido. A RPC valida tudo antes de escrever seja o que
 *    for, e escreve numa instrução só.
 *
 * Separada de `moveLeadStage` de propósito: arrastar para priorizar não é uma
 * mudança de estado e não deve encher a timeline nem a auditoria.
 */
export async function reorderLeads(
  stage: string,
  ordens: z.input<typeof ordemSchema>[],
): Promise<ActionResult<{ atualizadas: number }>> {
  const parsed = z
    .object({
      stage: z.enum(LEAD_STAGES),
      ordens: z.array(ordemSchema).max(500),
    })
    .safeParse({ stage, ordens });

  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("reorder_crm_leads_atomic", {
      p_company_id: profile.company_id,
      p_stage: parsed.data.stage,
      p_items: parsed.data.ordens,
      p_actor: profile.id,
    });

    if (error) return erroDoFunil("reorderLeads", new Error(error.message));

    invalidateBusinessState({ domains: ["leads"] });
    const linha = Array.isArray(data) ? data[0] : data;
    return actionSuccess({ atualizadas: Number(linha?.atualizadas ?? parsed.data.ordens.length) });
  } catch (err) {
    return erroDoFunil("reorderLeads", err);
  }
}

const interacaoSchema = z.object({
  kind: z.enum(MANUAL_INTERACTION_KINDS as unknown as [string, ...string[]]),
  summary: z.string().trim().min(1, "Escreva o que aconteceu.").max(2000),
  occurredAt: z
    .union([z.literal(""), z.iso.datetime({ offset: true }), z.iso.date()])
    .optional()
    .nullable(),
});

export async function addLeadInteraction(
  leadId: string,
  input: z.input<typeof interacaoSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = interacaoSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  // A lead tem de ser desta empresa. A FK composta da 101 também o garante,
  // mas aqui devolve-se "não encontrada" em vez de um erro de restrição.
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id")
    .eq("company_id", profile.company_id)
    .eq("id", leadId)
    .maybeSingle();

  if (!lead) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");

  const { data, error } = await admin
    .from("crm_lead_interactions")
    .insert({
      company_id: profile.company_id,
      lead_id: leadId,
      kind: parsed.data.kind,
      summary: parsed.data.summary,
      ...(parsed.data.occurredAt
        ? { occurred_at: new Date(parsed.data.occurredAt).toISOString() }
        : {}),
      author_id: profile.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    logQueryFailure("addLeadInteraction", error);
    return internalFailure("addLeadInteraction", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: data.id });
}

/**
 * Arquiva a lead — não a apaga.
 *
 * Apagar uma lead perdida destruiria o motivo da perda, que é metade da razão
 * de haver um funil. Arquivada, sai das listas e continua a contar nos
 * relatórios.
 */
export async function archiveLead(leadId: string): Promise<ActionResult<{ id: string }>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_leads")
    .update({ archived_at: new Date().toISOString() })
    .eq("company_id", profile.company_id)
    .eq("id", leadId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    logQueryFailure("archiveLead", error);
    return internalFailure("archiveLead", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!data) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada ou já arquivada.");
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "lead_archived",
    entityType: "crm_lead",
    entityId: leadId,
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: leadId });
}

// ── Interno ─────────────────────────────────────────────────────────────────
//
// 🔴 `registarInteracao` foi REMOVIDA nesta ronda, e a ausência é o ponto.
//
//    Era o helper que escrevia no diário em best-effort, a seguir ao `UPDATE`
//    do estado, engolindo o erro. Permitia a lead mudar de coluna sem a
//    timeline registar porquê — e é para responder a isso que a timeline
//    existe.
//
//    O diário passou a ser escrito DENTRO de `move_crm_lead_stage_atomic`, na
//    mesma transação do estado. Deixar aqui o helper antigo seria deixar à mão
//    o caminho que se acabou de fechar.
