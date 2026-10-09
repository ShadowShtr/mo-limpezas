"use server";

import { z } from "zod";
import { requireProfile } from "@/lib/auth-guard";
import { ACTION_ERROR_CODES, actionFailure, actionSuccess, internalFailure, validationFailure, type ActionResult } from "@/lib/action-result";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";
import { COLUMN_COLORS, type CrmColumn } from "@/lib/crm/columns";
import { LEAD_STAGES, type LeadStage } from "@/lib/crm/stages";

const columnSchema = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(COLUMN_COLORS) });

export async function getCrmColumns(): Promise<ActionResult<CrmColumn[]>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem acesso ao CRM.");
  const { data, error } = await guard.admin.from("crm_board_columns").select("id,name,color")
    .eq("company_id", guard.profile.company_id).order("created_at").order("id");
  if (error) return internalFailure("getCrmColumns", error);
  return actionSuccess((data ?? []) as CrmColumn[]);
}

export async function saveCrmColumn(id: string | null, input: z.input<typeof columnSchema>): Promise<ActionResult<CrmColumn>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para gerir colunas.");
  const parsed = z.object({ id: z.uuid().nullable(), input: columnSchema }).safeParse({ id, input });
  if (!parsed.success) return validationFailure(parsed.error);
  const { admin, profile } = guard;
  const query = parsed.data.id
    ? admin.from("crm_board_columns").update(parsed.data.input).eq("company_id", profile.company_id).eq("id", parsed.data.id)
    : admin.from("crm_board_columns").insert({ ...parsed.data.input, company_id: profile.company_id });
  const { data, error } = await query.select("id,name,color").maybeSingle();
  if (error) return internalFailure("saveCrmColumn", error);
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Coluna não encontrada.");
  await auditLog({ companyId: profile.company_id, actorId: profile.id,
    action: id ? "crm_column_updated" : "crm_column_created", entityType: "crm_board_column", entityId: data.id,
    after: parsed.data.input }, admin);
  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess(data as CrmColumn);
}

export async function deleteCrmColumn(id: string): Promise<ActionResult<{ id: string }>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para gerir colunas.");
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error);
  const { admin, profile } = guard;
  // A FK devolve os cartões ao funil na mesma instrução; nenhum cartão é apagado.
  const { data, error } = await admin.from("crm_board_columns").delete()
    .eq("company_id", profile.company_id).eq("id", parsed.data).select("id").maybeSingle();
  if (error) return internalFailure("deleteCrmColumn", error);
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Coluna não encontrada.");
  await auditLog({ companyId: profile.company_id, actorId: profile.id,
    action: "crm_column_deleted", entityType: "crm_board_column", entityId: id }, admin);
  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess(data);
}

const boardSchema = z.object({
  leadId: z.uuid(), expectedStage: z.enum(LEAD_STAGES), expectedExtraColumnId: z.uuid().nullable(),
  extraColumnId: z.uuid().nullable(), stage: z.enum(LEAD_STAGES).optional(),
  lostReason: z.string().max(100).nullable().optional(), lostReasonNotes: z.string().max(1000).nullable().optional(),
}).refine((v) => v.extraColumnId !== null || v.stage !== undefined, { message: "Escolha a coluna de destino." });

export async function moveLeadBoard(input: z.input<typeof boardSchema>): Promise<ActionResult<{ stage: LeadStage; extra_column_id: string | null }>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para organizar o CRM.");
  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);
  const { admin, profile } = guard;
  const value = parsed.data;
  const { data, error } = await admin.rpc("move_crm_lead_board_atomic", {
    p_company_id: profile.company_id, p_actor: profile.id, p_lead_id: value.leadId,
    p_expected_stage: value.expectedStage, p_expected_extra_column_id: value.expectedExtraColumnId,
    p_extra_column_id: value.extraColumnId, p_stage: value.stage ?? null,
    p_lost_reason: value.lostReason ?? null, p_lost_reason_notes: value.lostReasonNotes ?? null,
  });
  if (error) {
    if (error.message.includes("CRM_BOARD_FORBIDDEN")) return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para organizar o CRM.");
    if (error.message.includes("CONFLICT")) return actionFailure(ACTION_ERROR_CODES.CONFLICT, "O cartão mudou entretanto. Atualize o quadro.");
    if (error.message.includes("NOT_FOUND")) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "O cartão ou a coluna já não existe.");
    if (error.message.includes("LEAD_LOST_REQUIRES_REASON")) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, "Indique o motivo da perda.");
    if (error.message.includes("LEAD_WIN_REQUIRES_CONVERSION")) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, "Converta a lead em cliente a partir do orçamento aceite.");
    if (error.message.includes("LEAD_TRANSITION_NOT_ALLOWED") || error.message.includes("LEAD_ALREADY_WON")) return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, "Esta mudança de estado não é permitida. As colunas extras continuam disponíveis para organizar o cartão.");
    return internalFailure("moveLeadBoard", error);
  }
  const row = data?.[0];
  if (!row) return internalFailure("moveLeadBoard", new Error("Empty board response"));
  await auditLog({ companyId: profile.company_id, actorId: profile.id, action: "crm_card_organized",
    entityType: "crm_lead", entityId: value.leadId,
    before: { stage: value.expectedStage, extra_column_id: value.expectedExtraColumnId }, after: row }, admin);
  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess(row as { stage: LeadStage; extra_column_id: string | null });
}
