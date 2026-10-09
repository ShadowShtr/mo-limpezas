"use server";

import { z } from "zod";
import { requireProfile, AUTH_GUARD_CODES } from "@/lib/auth-guard";
import {
  ACTION_ERROR_CODES, actionFailure, actionSuccess, internalFailure,
  validationFailure, type ActionResult,
} from "@/lib/action-result";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";

const inputSchema = z.object({
  tipo: z.enum(["lead", "visita", "orcamento"]),
  id: z.uuid(),
});

const tabelas = {
  lead: "crm_leads", visita: "crm_visits", orcamento: "crm_quotes",
} as const;

/** Uma única instrução: as FKs removem os dependentes ou recusam tudo. */
export async function excluirRegistoCrm(
  tipo: "lead" | "visita" | "orcamento",
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) {
    return actionFailure(
      guard.code === AUTH_GUARD_CODES.UNAUTHENTICATED
        ? ACTION_ERROR_CODES.UNAUTHENTICATED : ACTION_ERROR_CODES.FORBIDDEN,
      "Sem permissão para excluir registos do CRM.",
    );
  }
  const parsed = inputSchema.safeParse({ tipo, id });
  if (!parsed.success) return validationFailure(parsed.error);

  const { admin, profile } = guard;
  // A condição faz parte do DELETE: uma conversão concorrente também protege a lead.
  const query = parsed.data.tipo === "lead"
    ? admin.from("crm_leads").delete()
      .eq("company_id", profile.company_id).eq("id", parsed.data.id)
      .is("converted_client_id", null).neq("stage", "ganho")
    : admin.from(tabelas[parsed.data.tipo]).delete()
      .eq("company_id", profile.company_id).eq("id", parsed.data.id);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    if (error.code === "23503") {
      return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE,
        tipo === "visita"
          ? "Esta visita está associada a um orçamento. Exclua primeiro o orçamento."
          : "Este registo tem revisões ou outros registos associados que impedem a exclusão.");
    }
    return internalFailure("excluirRegistoCrm", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!data) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND,
      tipo === "lead"
        ? "Lead não encontrada ou já convertida em cliente."
        : "Registo não encontrado ou já excluído.");
  }
  await auditLog({
    companyId: profile.company_id, actorId: profile.id,
    action: "crm_record_deleted", entityType: tabelas[parsed.data.tipo], entityId: data.id,
  }, admin);
  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: data.id });
}
