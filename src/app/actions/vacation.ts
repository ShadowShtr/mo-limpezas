"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { calcVacationEntitlement } from "@/lib/vacation-entitlement";

export interface VacationRequest {
  id: string;
  collaborator_id: string;
  collaborator_name?: string;
  starts_on: string;
  ends_on: string;
  days_count: number | null;
  status: "pendente" | "aprovado" | "rejeitado";
  notes: string | null;
  rejection_reason: string | null;
  created_at: string;
}

/** Conta dias úteis (exclui sábados e domingos) entre duas datas inclusive. */
function countWeekdays(start: string, end: string): number {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  let count = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// ── Colaborador: criar pedido de férias ───────────────────────────────────────
export async function createVacationRequest(input: {
  starts_on: string;
  ends_on: string;
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return { ok: false, error: "Perfil não encontrado." };

  if (input.ends_on < input.starts_on) {
    return { ok: false, error: "A data de fim não pode ser anterior à de início." };
  }

  const { error } = await admin.from("vacation_requests").insert({
    company_id: profile.company_id,
    collaborator_id: user.id,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    days_count: countWeekdays(input.starts_on, input.ends_on),
    status: "pendente",
    notes: input.notes ?? null,
  });

  if (error) return { ok: false, error: error.message };

  // Notificar gestores do pedido de férias
  const [{ data: collab }, { data: managers }] = await Promise.all([
    admin.from("profiles").select("full_name").eq("id", user.id).single(),
    admin.from("profiles").select("id").eq("company_id", profile.company_id).in("role", ["gestor", "admin"]),
  ]);
  if (managers && managers.length > 0) {
    const name = collab?.full_name ?? "Uma colaboradora";
    const dias = countWeekdays(input.starts_on, input.ends_on);
    await admin.from("notifications").insert(
      managers.map((m: { id: string }) => ({
        company_id: profile.company_id,
        user_id:    m.id,
        type:       "vacation_requested",
        title:      `${name} pediu ${dias} dia(s) de férias`,
        body:       `De ${input.starts_on} a ${input.ends_on}.${input.notes ? ` "${input.notes}"` : ""}`,
        data:       { collaborator_id: user.id },
      })),
    );
  }

  revalidatePath("/app/ausencias");
  revalidatePath("/dashboard/faltas");
  return { ok: true };
}

// ── Colaborador: registar uma falta própria ───────────────────────────────────
export async function createOwnAbsence(input: {
  absence_type: "doenca_com_baixa" | "doenca_sem_baixa" | "pessoal_justificado" | "outro";
  starts_on: string;
  ends_on: string;
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return { ok: false, error: "Perfil não encontrado." };

  if (input.ends_on < input.starts_on) {
    return { ok: false, error: "A data de fim não pode ser anterior à de início." };
  }

  const { error } = await admin.from("absences").insert({
    company_id: profile.company_id,
    collaborator_id: user.id,
    absence_type: input.absence_type,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    notes: input.notes ?? null,
    created_by: user.id,
  });

  if (error) return { ok: false, error: error.message };

  // Notificar gestores da falta registada
  const ABSENCE_LABELS: Record<string, string> = {
    doenca_com_baixa:      "doença (com baixa)",
    doenca_sem_baixa:      "doença (sem baixa)",
    pessoal_justificado:   "motivo pessoal justificado",
    outro:                 "outro motivo",
  };

  const [{ data: collab }, { data: managers }] = await Promise.all([
    admin.from("profiles").select("full_name").eq("id", user.id).single(),
    admin.from("profiles").select("id").eq("company_id", profile.company_id).in("role", ["gestor", "admin"]),
  ]);
  if (managers && managers.length > 0) {
    const name = collab?.full_name ?? "Uma colaboradora";
    const label = ABSENCE_LABELS[input.absence_type] ?? input.absence_type;
    await admin.from("notifications").insert(
      managers.map((m: { id: string }) => ({
        company_id: profile.company_id,
        user_id:    m.id,
        type:       "absence_requested",
        title:      `${name} registou uma falta`,
        body:       `Motivo: ${label}. De ${input.starts_on} a ${input.ends_on}.${input.notes ? ` "${input.notes}"` : ""}`,
        data:       { collaborator_id: user.id },
      })),
    );
  }

  revalidatePath("/app/ausencias");
  revalidatePath("/dashboard/faltas");
  return { ok: true };
}

// ── Colaborador: os meus pedidos + faltas ─────────────────────────────────────
export async function getMyRequests(): Promise<{
  vacations: VacationRequest[];
  absences: Array<{ id: string; absence_type: string; starts_on: string; ends_on: string; notes: string | null; created_at: string }>;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { vacations: [], absences: [] };

  const admin = createAdminClient();
  const [{ data: vacations }, { data: absences }] = await Promise.all([
    admin.from("vacation_requests")
      .select("id, collaborator_id, starts_on, ends_on, days_count, status, notes, rejection_reason, created_at")
      .eq("collaborator_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("absences")
      .select("id, absence_type, starts_on, ends_on, notes, created_at")
      .eq("collaborator_id", user.id)
      .order("starts_on", { ascending: false }),
  ]);

  return {
    vacations: (vacations as VacationRequest[]) ?? [],
    absences: absences ?? [],
  };
}

// ── Gestor: listar pedidos pendentes ──────────────────────────────────────────
export async function getPendingVacationRequests(): Promise<VacationRequest[]> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: me } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!me || !["admin", "gestor"].includes(me.role)) return [];

  const { data } = await admin
    .from("vacation_requests")
    .select("id, collaborator_id, starts_on, ends_on, days_count, status, notes, rejection_reason, created_at, profiles!collaborator_id(full_name)")
    .eq("company_id", me.company_id)
    .order("created_at", { ascending: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data as any[]) ?? []).map((r) => ({
    ...r,
    collaborator_name: r.profiles?.full_name ?? "—",
  }));
}

// ── Gestor: aprovar/rejeitar ──────────────────────────────────────────────────
export async function reviewVacationRequest(
  id: string,
  decision: "aprovado" | "rejeitado",
  rejectionReason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: me } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!me || !["admin", "gestor"].includes(me.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  const { data: req } = await admin
    .from("vacation_requests")
    .select("id, company_id, collaborator_id, starts_on, ends_on")
    .eq("id", id)
    .eq("company_id", me.company_id)
    .single();
  if (!req) return { ok: false, error: "Pedido não encontrado." };

  const { error } = await admin
    .from("vacation_requests")
    .update({
      status: decision,
      rejection_reason: decision === "rejeitado" ? (rejectionReason ?? null) : null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // Ao aprovar: criar a ausência de férias correspondente
  if (decision === "aprovado") {
    await admin.from("absences").insert({
      company_id: req.company_id,
      collaborator_id: req.collaborator_id,
      absence_type: "ferias",
      starts_on: req.starts_on,
      ends_on: req.ends_on,
      approved_by: user.id,
      created_by: user.id,
    });
  }

  // Notificar o colaborador
  await admin.from("notifications").insert({
    company_id: req.company_id,
    user_id: req.collaborator_id,
    type: decision === "aprovado" ? "vacation_approved" : "vacation_rejected",
    title: decision === "aprovado" ? "Férias aprovadas" : "Férias rejeitadas",
    body: decision === "aprovado"
      ? `O teu pedido de ${req.starts_on} a ${req.ends_on} foi aprovado.`
      : `O teu pedido de ${req.starts_on} a ${req.ends_on} foi rejeitado.${rejectionReason ? ` Motivo: ${rejectionReason}` : ""}`,
    data: { request_id: id },
  });

  revalidatePath("/dashboard/faltas");
  revalidatePath("/app/ausencias");
  return { ok: true };
}

// ── Gestor: visão geral das férias de todos os colaboradores (aba "Férias") ────
export interface EmployeeVacationOverview {
  id: string;
  full_name: string;
  contract_start: string | null;
  vacation_balance: number;
  /** Dias a que tem direito nesse ano civil, calculado pelo modelo legal PT a partir de contract_start. Null se não há data de início de contrato definida. */
  entitlement_days: number | null;
  used_days_year: number;
  /** entitlement_days - used_days_year (nunca negativo). Null se entitlement_days for null. */
  available_days: number | null;
  periods: { starts_on: string; ends_on: string; days: number }[];
  pending_requests: number;
}

export async function getAllVacationsOverview(year: number): Promise<EmployeeVacationOverview[]> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: me } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!me || !["admin", "gestor"].includes(me.role)) return [];

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const [{ data: employees }, { data: absences }, { data: pending }] = await Promise.all([
    admin.from("profiles")
      .select("id, full_name, vacation_balance, contract_start")
      .eq("company_id", me.company_id)
      .eq("status", "ativo")
      .in("role", ["colaborador", "gestor"])
      .order("full_name"),
    admin.from("absences")
      .select("collaborator_id, starts_on, ends_on")
      .eq("company_id", me.company_id)
      .eq("absence_type", "ferias")
      .lte("starts_on", yearEnd)
      .gte("ends_on", yearStart),
    admin.from("vacation_requests")
      .select("collaborator_id")
      .eq("company_id", me.company_id)
      .eq("status", "pendente"),
  ]);

  const pendingCount: Record<string, number> = {};
  for (const p of pending ?? []) pendingCount[p.collaborator_id] = (pendingCount[p.collaborator_id] ?? 0) + 1;

  const periodsByEmployee: Record<string, { starts_on: string; ends_on: string; days: number }[]> = {};
  for (const a of absences ?? []) {
    const clampedStart = a.starts_on < yearStart ? yearStart : a.starts_on;
    const clampedEnd = a.ends_on > yearEnd ? yearEnd : a.ends_on;
    const days = countWeekdays(clampedStart, clampedEnd);
    (periodsByEmployee[a.collaborator_id] ??= []).push({ starts_on: a.starts_on, ends_on: a.ends_on, days });
  }

  return (employees ?? []).map((e) => {
    const periods = (periodsByEmployee[e.id] ?? []).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const usedDaysYear = periods.reduce((sum, p) => sum + p.days, 0);
    const entitlementDays = e.contract_start ? calcVacationEntitlement(e.contract_start, year) : null;
    return {
      id: e.id,
      full_name: e.full_name,
      contract_start: e.contract_start,
      vacation_balance: e.vacation_balance ?? 0,
      entitlement_days: entitlementDays,
      used_days_year: usedDaysYear,
      available_days: entitlementDays != null ? Math.max(0, entitlementDays - usedDaysYear) : null,
      periods,
      pending_requests: pendingCount[e.id] ?? 0,
    };
  });
}
