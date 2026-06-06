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
  const companyId = await getCompanyId();

  const { error } = await admin.from("absences").insert({
    company_id: companyId,
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
  const admin = createAdminClient();
  const { error } = await admin.from("absences").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/dashboard/faltas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}

export async function updateAbsenceSubstitute(absenceId: string, replacedById: string | null) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("absences")
    .update({ replaced_by: replacedById })
    .eq("id", absenceId);
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

  // Para cada colaborador, verificar quantos serviços têm no período
  const suggestions: (SubstituteSuggestion | null)[] = await Promise.all(
    (allCollabs ?? []).map(async (c) => {
      // Obter as equipas a que este colaborador pertence
      const { data: memberTeams } = await admin
        .from("team_members")
        .select("team_id")
        .eq("collaborator_id", c.id)
        .is("left_at", null);

      const teamIds = (memberTeams ?? []).map((t) => t.team_id);

      // Contar serviços dessas equipas no período
      let conflictCount = 0;
      if (teamIds.length > 0) {
        const { count } = await admin
          .from("services")
          .select("id", { count: "exact", head: true })
          .in("team_id", teamIds)
          .gte("scheduled_start", `${startsOn}T00:00:00`)
          .lte("scheduled_start", `${endsOn}T23:59:59`)
          .in("status", ["agendado", "em_curso"]);
        conflictCount = count ?? 0;
      }

      // Verificar se está ausente no mesmo período
      const { data: alsoAbsent } = await admin
        .from("absences")
        .select("id")
        .eq("collaborator_id", c.id)
        .lte("starts_on", endsOn)
        .gte("ends_on", startsOn)
        .limit(1);

      if (alsoAbsent && alsoAbsent.length > 0) return null;

      // Score: mais skills em comum = maior score
      const cSkills: string[] = c.skills ?? [];
      const commonSkills = cSkills.filter((s) => absentSkills.includes(s)).length;
      const score = commonSkills * 10 - conflictCount;

      return {
        id: c.id,
        full_name: c.full_name,
        skills: cSkills,
        conflicting_services: conflictCount,
        score,
      } satisfies SubstituteSuggestion;
    }),
  );

  const filtered = suggestions
    .filter((s): s is SubstituteSuggestion => s !== null)
    .sort((a, b) => b.score - a.score);

  return { ok: true, data: filtered };
}
