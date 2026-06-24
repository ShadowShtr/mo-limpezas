"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export type AbsenceType =
  | "doenca_com_baixa"
  | "doenca_sem_baixa"
  | "pessoal_justificado"
  | "pessoal_injustificado"
  | "ferias"
  | "feriado"
  | "formacao"
  | "outro";

export interface CreateAbsenceInput {
  collaborator_id: string;
  absence_type: AbsenceType;
  starts_on: string;
  ends_on: string;
  notes?: string;
}

export interface SubstituteSuggestion {
  id: string;
  full_name: string;
  skills: string[];
  conflicting_services: number;
  score: number; // higher = better match
}

async function getCompanyId(): Promise<string> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data } = await admin.from("profiles").select("company_id").eq("id", user!.id).single();
  return data?.company_id ?? "";
}

export async function createAbsence(input: CreateAbsenceInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: actor } = await admin.from("profiles").select("role, company_id").eq("id", user.id).single();
  if (!actor || !["admin", "gestor"].includes(actor.role)) return { ok: false as const, error: "Sem permissão." };

  const { error } = await admin.from("absences").insert({
    company_id: actor.company_id,
    collaborator_id: input.collaborator_id,
    absence_type: input.absence_type,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    notes: input.notes ?? null,
    created_by: user!.id,
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/faltas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}

export async function deleteAbsence(id: string) {
  const supabase = await createClient();
  const admin    = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };
  const companyId = await getCompanyId();
  if (!companyId) return { ok: false as const, error: "Sem permissão." };
  const { error } = await admin.from("absences").delete().eq("id", id).eq("company_id", companyId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/dashboard/faltas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}

export async function updateAbsenceSubstitute(absenceId: string, replacedById: string | null) {
  const supabase = await createClient();
  const admin    = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };
  const companyId = await getCompanyId();
  if (!companyId) return { ok: false as const, error: "Sem permissão." };
  const { error } = await admin
    .from("absences")
    .update({ replaced_by: replacedById })
    .eq("id", absenceId)
    .eq("company_id", companyId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/dashboard/faltas");
  return { ok: true as const };
}

// Motor de substituição: sugere colaboradores disponíveis no período
export async function getSubstituteSuggestions(
  collaboratorId: string,
  startsOn: string,
  endsOn: string,
): Promise<{ ok: true; data: SubstituteSuggestion[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const companyId = await getCompanyId();

  // Skills do colaborador ausente
  const { data: absent } = await admin
    .from("profiles")
    .select("skills")
    .eq("id", collaboratorId)
    .single();

  const absentSkills: string[] = absent?.skills ?? [];

  // Todos os colaboradores ativos da empresa, excepto o ausente
  const { data: allCollabs, error } = await admin
    .from("profiles")
    .select("id, full_name, skills")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .neq("id", collaboratorId)
    .in("role", ["colaborador", "gestor"]);

  if (error) return { ok: false, error: error.message };

  const collabIds = (allCollabs ?? []).map((c) => c.id);
  if (collabIds.length === 0) return { ok: true, data: [] };

  // 3 queries totais em paralelo (era N×3 individual)
  const [membershipsRes, absencesRes] = await Promise.all([
    admin
      .from("team_members")
      .select("collaborator_id, team_id")
      .in("collaborator_id", collabIds)
      .is("left_at", null),
    admin
      .from("absences")
      .select("collaborator_id")
      .in("collaborator_id", collabIds)
      .lte("starts_on", endsOn)
      .gte("ends_on", startsOn),
  ]);

  // Conjunto de ausentes no período (para exclusão rápida)
  const absentSet = new Set((absencesRes.data ?? []).map((a) => a.collaborator_id));

  // Agrupar equipas por colaborador
  const teamsByCollab = new Map<string, string[]>();
  for (const m of membershipsRes.data ?? []) {
    const list = teamsByCollab.get(m.collaborator_id) ?? [];
    list.push(m.team_id);
    teamsByCollab.set(m.collaborator_id, list);
  }

  // Uma query para contar serviços de todas as equipas em jogo
  const allTeamIds = [...new Set((membershipsRes.data ?? []).map((m) => m.team_id))];
  const servicesByTeam = new Map<string, number>();
  if (allTeamIds.length > 0) {
    const { data: services } = await admin
      .from("services")
      .select("team_id")
      .in("team_id", allTeamIds)
      .gte("scheduled_start", `${startsOn}T00:00:00`)
      .lte("scheduled_start", `${endsOn}T23:59:59`)
      .in("status", ["agendado", "em_curso"]);
    for (const s of services ?? []) {
      if (!s.team_id) continue;
      servicesByTeam.set(s.team_id, (servicesByTeam.get(s.team_id) ?? 0) + 1);
    }
  }

  const suggestions: SubstituteSuggestion[] = [];
  for (const c of allCollabs ?? []) {
    if (absentSet.has(c.id)) continue;

    const teams = teamsByCollab.get(c.id) ?? [];
    const conflictCount = teams.reduce((sum, tid) => sum + (servicesByTeam.get(tid) ?? 0), 0);

    const cSkills: string[] = c.skills ?? [];
    const commonSkills = cSkills.filter((s) => absentSkills.includes(s)).length;
    const score = commonSkills * 10 - conflictCount;

    suggestions.push({ id: c.id, full_name: c.full_name, skills: cSkills, conflicting_services: conflictCount, score });
  }

  return { ok: true, data: suggestions.sort((a, b) => b.score - a.score) };
}
