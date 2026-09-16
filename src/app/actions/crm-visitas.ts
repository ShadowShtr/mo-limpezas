"use server";

// ============================================================================
// CRM — a agenda de visitas comerciais
// ============================================================================
//
// 🔴 Só funções assíncronas. As constantes vivem em `src/lib/crm/visits.ts`.
//
// 🔴 Uma visita NUNCA cria um serviço, um contrato ou um local. É a fronteira
//    que a migration 102 explica por extenso, e que `crm-actions-guard.test.ts`
//    verifica: marcar uma visita não pode fazer aparecer trabalho a fingir no
//    calendário, na escala ou nas cobranças.
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
import { notifyUser } from "@/lib/push-notify";
import { VISIT_STATUSES, VISIT_STATUS_LABELS, type VisitStatus } from "@/lib/crm/visits";

export interface VisitRow {
  id: string;
  lead_id: string | null;
  client_id: string | null;
  /** Quem vai ser visitado — nome da lead ou do cliente, resolvido na leitura. */
  target_name: string;
  scheduled_start: string;
  scheduled_end: string;
  assigned_to: string | null;
  assigned_name: string | null;
  address: string | null;
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  outcome_notes: string | null;
  area_sqm: number | null;
  estimated_hours: number | null;
  frequency_hint: string | null;
}

const VISIT_SELECT = `
  id, lead_id, client_id, scheduled_start, scheduled_end,
  assigned_to, address, status, completed_at, cancelled_at, cancel_reason,
  outcome_notes, area_sqm, estimated_hours, frequency_hint
`;

function recusa(code: string): ActionResult<never> {
  if (code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
    return actionFailure(ACTION_ERROR_CODES.UNAUTHENTICATED, "Não autenticado.");
  }
  if (code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Perfil não encontrado.");
  }
  return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para gerir visitas.");
}

const visitaSchema = z
  .object({
    leadId: z.uuid().optional().nullable(),
    clientId: z.uuid().optional().nullable(),
    scheduledStart: z.iso.datetime({ offset: true }),
    scheduledEnd: z.iso.datetime({ offset: true }),
    assignedTo: z.uuid().optional().nullable(),
    address: z.string().trim().max(500).optional().nullable(),
  })
  // As duas regras que a base também impõe. Aqui produzem uma mensagem que se
  // entende; lá, uma violação de restrição.
  .refine((v) => Boolean(v.leadId) !== Boolean(v.clientId), {
    message: "A visita é a uma lead ou a um cliente — escolha um.",
    path: ["leadId"],
  })
  .refine((v) => new Date(v.scheduledEnd) > new Date(v.scheduledStart), {
    message: "A visita não pode acabar antes de começar.",
    path: ["scheduledEnd"],
  });

export type VisitaInput = z.input<typeof visitaSchema>;

/**
 * As visitas de um intervalo, ou as de uma lead.
 *
 * Sem intervalo, devolve as agendadas de hoje em diante — é a pergunta que a
 * agenda faz ao abrir.
 */
export async function getVisits(opts?: {
  desde?: string;
  ate?: string;
  leadId?: string;
}): Promise<ActionResult<VisitRow[]>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  let query = admin
    .from("crm_visits")
    .select(VISIT_SELECT)
    .eq("company_id", profile.company_id);

  if (opts?.leadId) query = query.eq("lead_id", opts.leadId);
  if (opts?.desde) query = query.gte("scheduled_start", opts.desde);
  if (opts?.ate) query = query.lte("scheduled_start", opts.ate);

  const { data, error } = await query.order("scheduled_start", { ascending: true });

  if (error) {
    logQueryFailure("getVisits", error);
    return internalFailure("getVisits", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  const linhas = (data ?? []) as unknown as Omit<VisitRow, "target_name" | "assigned_name">[];

  // Os nomes vêm de três tabelas. Resolvidos aqui, de uma vez, em vez de um
  // join por linha — e uma falha a resolver nomes não esconde a agenda.
  const leadIds = [...new Set(linhas.map((v) => v.lead_id).filter(Boolean))] as string[];
  const clientIds = [...new Set(linhas.map((v) => v.client_id).filter(Boolean))] as string[];
  const pessoaIds = [...new Set(linhas.map((v) => v.assigned_to).filter(Boolean))] as string[];

  const nomes = new Map<string, string>();

  if (leadIds.length > 0) {
    const { data: leads } = await admin
      .from("crm_leads")
      .select("id, name")
      .eq("company_id", profile.company_id)
      .in("id", leadIds);
    for (const l of leads ?? []) nomes.set(l.id, l.name);
  }
  if (clientIds.length > 0) {
    const { data: clientes } = await admin
      .from("clients")
      .select("id, name")
      .eq("company_id", profile.company_id)
      .in("id", clientIds);
    for (const c of clientes ?? []) nomes.set(c.id, c.name);
  }
  if (pessoaIds.length > 0) {
    const { data: perfis } = await admin.from("profiles").select("id, full_name").in("id", pessoaIds);
    for (const p of perfis ?? []) nomes.set(p.id, p.full_name);
  }

  return actionSuccess(
    linhas.map((v) => ({
      ...v,
      target_name: nomes.get((v.lead_id ?? v.client_id) as string) ?? "—",
      assigned_name: v.assigned_to ? nomes.get(v.assigned_to) ?? null : null,
    })),
  );
}

export async function scheduleVisit(input: VisitaInput): Promise<ActionResult<{ id: string }>> {
  const parsed = visitaSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const d = parsed.data;

  const { data, error } = await admin
    .from("crm_visits")
    .insert({
      company_id: profile.company_id,
      lead_id: d.leadId ?? null,
      client_id: d.clientId ?? null,
      scheduled_start: d.scheduledStart,
      scheduled_end: d.scheduledEnd,
      assigned_to: d.assignedTo ?? null,
      address: d.address ?? null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    logQueryFailure("scheduleVisit", error);
    return internalFailure("scheduleVisit", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  // Marcar uma visita a alguém sem lhe dizer é a forma mais fácil de ela não
  // acontecer. Falhar o aviso não desmarca a visita — `notifyUser` não lança.
  if (d.assignedTo && d.assignedTo !== profile.id) {
    await notifyUser(admin, {
      companyId: profile.company_id,
      userId: d.assignedTo,
      type: "crm_visit_assigned",
      title: "Visita comercial marcada",
      body: `Tem uma visita marcada para ${new Intl.DateTimeFormat("pt-PT", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Lisbon",
      }).format(new Date(d.scheduledStart))}.`,
      url: "/dashboard/crm/visitas",
    });
  }

  // A visita entra na história da lead: quem abrir a ficha vê que foi marcada
  // e quando, sem ter de ir à agenda.
  if (d.leadId) {
    await registarNaLead(admin, profile.company_id, d.leadId, profile.id,
      `Visita marcada para ${d.scheduledStart.slice(0, 10)}.`);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_visit_scheduled",
    entityType: "crm_visit",
    entityId: data.id,
    after: { scheduled_start: d.scheduledStart, assigned_to: d.assignedTo ?? null },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: data.id });
}

const desfechoSchema = z.object({
  status: z.enum(VISIT_STATUSES),
  outcomeNotes: z.string().trim().max(5000).optional().nullable(),
  areaSqm: z.number().positive().max(1_000_000).optional().nullable(),
  estimatedHours: z.number().positive().max(999).optional().nullable(),
  frequencyHint: z.string().trim().max(200).optional().nullable(),
  cancelReason: z.string().trim().max(500).optional().nullable(),
});

/**
 * Fecha a visita — realizada, não compareceu, ou cancelada.
 *
 * As datas de desfecho são postas aqui e não pedidas ao utilizador: a base
 * exige-as (CHECK da 102) e ninguém deve ter de as escrever à mão.
 */
export async function setVisitOutcome(
  visitId: string,
  input: z.input<typeof desfechoSchema>,
): Promise<ActionResult<{ status: VisitStatus }>> {
  const parsed = desfechoSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;
  const destino = parsed.data.status;
  const agora = new Date().toISOString();

  const { data: atual } = await admin
    .from("crm_visits")
    .select("id, lead_id, status")
    .eq("company_id", profile.company_id)
    .eq("id", visitId)
    .maybeSingle();

  if (!atual) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Visita não encontrada.");

  const { error } = await admin
    .from("crm_visits")
    .update({
      status: destino,
      completed_at: destino === "realizada" ? agora : null,
      cancelled_at: destino === "cancelada" ? agora : null,
      cancel_reason: destino === "cancelada" ? parsed.data.cancelReason ?? null : null,
      outcome_notes: parsed.data.outcomeNotes ?? null,
      area_sqm: parsed.data.areaSqm ?? null,
      estimated_hours: parsed.data.estimatedHours ?? null,
      frequency_hint: parsed.data.frequencyHint ?? null,
    })
    .eq("company_id", profile.company_id)
    .eq("id", visitId);

  if (error) {
    logQueryFailure("setVisitOutcome", error);
    return internalFailure("setVisitOutcome", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  if (atual.lead_id) {
    await registarNaLead(admin, profile.company_id, atual.lead_id, profile.id,
      `Visita: ${VISIT_STATUS_LABELS[destino]}.`);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_visit_outcome",
    entityType: "crm_visit",
    entityId: visitId,
    before: { status: atual.status },
    after: { status: destino },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ status: destino });
}

export async function rescheduleVisit(
  visitId: string,
  input: { scheduledStart: string; scheduledEnd: string; assignedTo?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const parsed = z
    .object({
      scheduledStart: z.iso.datetime({ offset: true }),
      scheduledEnd: z.iso.datetime({ offset: true }),
      assignedTo: z.uuid().optional().nullable(),
    })
    .refine((v) => new Date(v.scheduledEnd) > new Date(v.scheduledStart), {
      message: "A visita não pode acabar antes de começar.",
      path: ["scheduledEnd"],
    })
    .safeParse(input);

  if (!parsed.success) return validationFailure(parsed.error);

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("crm_visits")
    .update({
      scheduled_start: parsed.data.scheduledStart,
      scheduled_end: parsed.data.scheduledEnd,
      assigned_to: parsed.data.assignedTo ?? null,
    })
    .eq("company_id", profile.company_id)
    .eq("id", visitId)
    .select("id")
    .maybeSingle();

  if (error) {
    logQueryFailure("rescheduleVisit", error);
    return internalFailure("rescheduleVisit", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!data) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Visita não encontrada.");

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_visit_rescheduled",
    entityType: "crm_visit",
    entityId: visitId,
    after: { scheduled_start: parsed.data.scheduledStart },
  }, admin);

  invalidateBusinessState({ domains: ["leads"] });
  return actionSuccess({ id: visitId });
}

// ── Interno ─────────────────────────────────────────────────────────────────

type AdminClient = Parameters<typeof notifyUser>[0];

/** Escreve na timeline da lead sem deixar que uma falha aqui parta a visita. */
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
