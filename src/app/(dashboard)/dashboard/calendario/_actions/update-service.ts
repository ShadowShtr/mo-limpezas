"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";
import { calculateServiceValue } from "@/lib/service-value";
import { revalidateBusinessPaths } from "@/lib/revalidate-business";

type AdminClient = ReturnType<typeof createAdminClient>;

type ConflictInfo = { reference_number: string; scheduled_start: string; scheduled_end: string };

type Authorized = { ok: true; userId: string; companyId: string };
type Unauthorized = { ok: false; error: string };

// Escritas do painel de detalhe do serviço (Causa 6 da auditoria): o
// componente de browser fazia update direto na tabela services pelo
// cliente Supabase do lado do cliente. Se o RLS bloqueasse, o Supabase devolvia
// sucesso com 0 linhas afetadas (sem erro) — a UI mostrava sucesso e nada
// era gravado. Estas actions confirmam linhas afetadas, marcam is_exception
// em serviços de contrato editados à mão, auditam e revalidam as rotas certas.

async function authorize(admin: AdminClient): Promise<Authorized | Unauthorized> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }
  return { ok: true, userId: user.id, companyId: profile.company_id };
}

async function revalidateAfterServiceChange(admin: AdminClient, locationId: string, includeCobrancas: boolean) {
  const { data: loc } = await admin.from("locations").select("client_id").eq("id", locationId).maybeSingle();
  revalidateBusinessPaths({
    clientId: loc?.client_id ?? null,
    scopes: includeCobrancas ? ["calendario", "clientes", "cobrancas"] : ["calendario", "clientes"],
  });
}

const NOTHING_WRITTEN_ERROR =
  "Nada foi gravado (sem permissão ou serviço inexistente). Atualize a página e tente novamente.";

// ─── updateServiceTime ──────────────────────────────────────────────────────

export type UpdateServiceTimeResult =
  | { ok: true; recalculatedValue: number | null }
  | { ok: false; error: string; conflicts?: ConflictInfo[] };

export async function updateServiceTime(
  serviceId: string,
  input: { startISO: string; endISO: string; force?: boolean },
): Promise<UpdateServiceTimeResult> {
  const admin = createAdminClient();
  const auth = await authorize(admin);
  if (!auth.ok) return auth;

  if (new Date(input.endISO).getTime() <= new Date(input.startISO).getTime()) {
    return { ok: false, error: "A hora de fim tem de ser depois do início." };
  }

  const { data: service } = await admin
    .from("services")
    .select("id, location_id, team_id, contract_id, status, scheduled_start, scheduled_end, hourly_rate, num_people, manual_value, upholstery_unit_price")
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .single();
  if (!service) return { ok: false, error: "Serviço não encontrado." };
  if (["concluido", "cancelado", "falta"].includes(service.status)) {
    return { ok: false, error: "Este serviço já está fechado e não pode ser editado." };
  }

  if (!input.force && service.team_id) {
    const { data: clashes } = await admin
      .from("services")
      .select("reference_number, scheduled_start, scheduled_end")
      .eq("team_id", service.team_id)
      .neq("id", serviceId)
      .in("status", ["agendado", "em_curso"])
      .lt("scheduled_start", input.endISO)
      .gt("scheduled_end", input.startISO);
    if (clashes && clashes.length > 0) {
      return { ok: false, error: "A equipa tem conflito neste horário.", conflicts: clashes as ConflictInfo[] };
    }
  }

  // Recalcula o valor pela nova duração (só serviços faturados por hora).
  // Valor manual, estofos por unidade e avença/valor fixo ficam intactos.
  const update: {
    scheduled_start: string; scheduled_end: string;
    calculated_value?: number; num_people?: number; is_exception?: boolean;
  } = { scheduled_start: input.startISO, scheduled_end: input.endISO };

  // Serviço de contrato editado à mão = exceção: a reescrita automática
  // (updateFutureServiceValuesForContract) nunca mais o pode reverter.
  if (service.contract_id != null) update.is_exception = true;

  let recalculated: number | null = null;
  const durationMin = (new Date(input.endISO).getTime() - new Date(input.startISO).getTime()) / 60000;
  if (
    service.hourly_rate != null &&
    service.manual_value == null &&
    service.upholstery_unit_price == null &&
    durationMin > 0
  ) {
    const ppl = service.num_people != null && service.num_people >= 1 ? service.num_people : 1;
    recalculated = calculateServiceValue({
      durationMin,
      hourlyRate: service.hourly_rate,
      numPeople: ppl,
      manualValue: null,
      fixedMonthly: false,
      contractFixedPrice: null,
      upholsteryUnits: null,
      upholsteryUnitPrice: null,
    });
    if (recalculated != null) update.calculated_value = recalculated;
  }

  const { data: updated, error } = await admin
    .from("services")
    .update(update)
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) return { ok: false, error: NOTHING_WRITTEN_ERROR };

  await auditLog({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: "service_time_changed",
    entityType: "service",
    entityId: serviceId,
    before: { scheduled_start: service.scheduled_start, scheduled_end: service.scheduled_end },
    after: { scheduled_start: input.startISO, scheduled_end: input.endISO },
    meta: { forced: !!input.force },
    source: "dashboard",
  }, admin);

  await revalidateAfterServiceChange(admin, service.location_id, recalculated != null);
  return { ok: true, recalculatedValue: recalculated };
}

// ─── updateServiceValue ─────────────────────────────────────────────────────

export type UpdateServiceValueResult =
  | { ok: true; appliedValue: number | null }
  | { ok: false; error: string };

export async function updateServiceValue(
  serviceId: string,
  input: { manualValue: number | null; applyVat: boolean },
): Promise<UpdateServiceValueResult> {
  const admin = createAdminClient();
  const auth = await authorize(admin);
  if (!auth.ok) return auth;

  const { data: service } = await admin
    .from("services")
    .select("id, location_id, contract_id, manual_value, apply_vat, calculated_value")
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .single();
  if (!service) return { ok: false, error: "Serviço não encontrado." };

  const update: { manual_value: number | null; apply_vat: boolean; is_exception?: boolean } = {
    manual_value: input.manualValue,
    apply_vat: input.applyVat,
  };
  if (service.contract_id != null) update.is_exception = true;

  const { data: updated, error } = await admin
    .from("services")
    .update(update)
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) return { ok: false, error: NOTHING_WRITTEN_ERROR };

  await auditLog({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: "service_value_changed",
    entityType: "service",
    entityId: serviceId,
    before: { manual_value: service.manual_value, apply_vat: service.apply_vat },
    after: { manual_value: input.manualValue, apply_vat: input.applyVat },
    source: "dashboard",
  }, admin);

  await revalidateAfterServiceChange(admin, service.location_id, true);
  return { ok: true, appliedValue: input.manualValue ?? service.calculated_value ?? null };
}

// ─── updateServiceNotes ─────────────────────────────────────────────────────

export type UpdateServiceNotesResult = { ok: true } | { ok: false; error: string };

export async function updateServiceNotes(
  serviceId: string,
  input: { notes: string | null },
): Promise<UpdateServiceNotesResult> {
  const admin = createAdminClient();
  const auth = await authorize(admin);
  if (!auth.ok) return auth;

  const { data: service } = await admin
    .from("services")
    .select("id, location_id, contract_id, notes")
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .single();
  if (!service) return { ok: false, error: "Serviço não encontrado." };

  const update: { notes: string | null; is_exception?: boolean } = { notes: input.notes };
  if (service.contract_id != null) update.is_exception = true;

  const { data: updated, error } = await admin
    .from("services")
    .update(update)
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) return { ok: false, error: NOTHING_WRITTEN_ERROR };

  await auditLog({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: "service_notes_changed",
    entityType: "service",
    entityId: serviceId,
    before: { notes: service.notes },
    after: { notes: input.notes },
    source: "dashboard",
  }, admin);

  await revalidateAfterServiceChange(admin, service.location_id, false);
  return { ok: true };
}

// ─── markServiceAbsence ─────────────────────────────────────────────────────

export type MarkServiceAbsenceResult = { ok: true } | { ok: false; error: string };

export async function markServiceAbsence(serviceId: string): Promise<MarkServiceAbsenceResult> {
  const admin = createAdminClient();
  const auth = await authorize(admin);
  if (!auth.ok) return auth;

  const { data: service } = await admin
    .from("services")
    .select("id, location_id, status")
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .single();
  if (!service) return { ok: false, error: "Serviço não encontrado." };

  const { data: updated, error } = await admin
    .from("services")
    .update({ status: "falta" })
    .eq("id", serviceId)
    .eq("company_id", auth.companyId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) return { ok: false, error: NOTHING_WRITTEN_ERROR };

  await auditLog({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: "service_marked_absence",
    entityType: "service",
    entityId: serviceId,
    before: { status: service.status },
    after: { status: "falta" },
    source: "dashboard",
  }, admin);

  await revalidateAfterServiceChange(admin, service.location_id, false);
  return { ok: true };
}
