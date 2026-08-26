"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { isValidIsoDateString } from "@/lib/utils";
import { isNoRowsError, logQueryFailure, queryFailure } from "@/lib/query-error";
import { requireProfile } from "@/lib/auth-guard";
import {
  resolveAvailability,
  isSuggestable,
  AVAILABILITY_UNCONFIRMED_MESSAGE,
  type AvailabilityState,
} from "@/domain/workforce/availability";

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
  /**
   * Estado de disponibilidade provado para o período pedido.
   *
   * Só `available` e `conflict` chegam aqui — ver `isSuggestable`. O campo
   * existe para que quem consome não tenha de inferir disponibilidade da
   * simples presença na lista, e para que `unknown` seja impossível de
   * confundir com `available` se alguma vez passar a ser devolvido.
   */
  availability: AvailabilityState;
}

/**
 * Resultado do motor de substituição.
 *
 * `rankingDegraded` sinaliza que uma fonte **opcional** falhou — hoje, as
 * competências da pessoa ausente. A lista continua correta quanto a quem pode
 * ir; o que fica pior é a ordem por afinidade. Uma fonte crítica a falhar não
 * produz isto: produz um erro.
 */
export interface SubstituteSuggestionsResult {
  data: SubstituteSuggestion[];
  rankingDegraded: boolean;
}

async function getCompanyId(): Promise<string> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data } = await admin.from("profiles").select("company_id").eq("auth_user_id", user!.id).single();
  return data?.company_id ?? "";
}

export async function createAbsence(input: CreateAbsenceInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: actor } = await admin.from("profiles").select("role, company_id").eq("auth_user_id", user.id).single();
  if (!actor || !["admin", "gestor"].includes(actor.role)) return { ok: false as const, error: "Sem permissão." };

  if (!isValidIsoDateString(input.starts_on)) {
    return { ok: false as const, error: "Data de início inválida." };
  }
  if (!isValidIsoDateString(input.ends_on)) {
    return { ok: false as const, error: "Data de fim inválida." };
  }
  if (input.ends_on < input.starts_on) {
    return { ok: false as const, error: "Data de fim anterior à data de início." };
  }

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

// ─── Motor de substituição ───────────────────────────────────────────────────
//
// 🔴 O defeito que este bloco corrige, em duas linhas do código anterior:
//
//       const absentSet = new Set((absencesRes.data ?? []).map(...));
//       logQueryFailure("...:services", servicesError);   // e continuava
//
//    A primeira transformava uma consulta de faltas falhada num conjunto de
//    ausentes vazio: quem estava de férias aparecia disponível para substituir
//    quem faltou. A segunda registava a falha dos serviços e seguia em frente
//    com `conflictCount` a zero: quem tinha o dia cheio aparecia livre.
//
//    Em ambos os casos o ecrã dizia "N colaboradores disponíveis" com a mesma
//    confiança de sempre. Não havia nada, em lado nenhum, a assinalar que
//    aquela lista tinha sido construída sobre uma pergunta sem resposta.
//
// A correção não é mostrar menos gente. É passar a existir a hipótese de
// dizer "não sei" — ver `src/domain/workforce/availability.ts`.
export async function getSubstituteSuggestions(
  collaboratorId: string,
  startsOn: string,
  endsOn: string,
): Promise<{ ok: true; data: SubstituteSuggestion[]; rankingDegraded: boolean } | { ok: false; error: string }> {
  // Escolher quem substitui quem é uma decisão de gestão, e expõe a lista de
  // colaboradores com as suas competências. O motor antigo resolvia a empresa
  // e mais nada — qualquer sessão autenticada podia pedi-la.
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // ── Fonte OPCIONAL: competências de quem falta ────────────────────────────
  //
  // Falhar aqui piora a ordenação por afinidade e mais nada — ninguém passa a
  // parecer livre. Degrada, não mente. Por isso não aborta, mas também não
  // finge que correu bem: sai sinalizado no resultado.
  const { data: absent, error: absentError } = await admin
    .from("profiles")
    .select("skills")
    .eq("id", collaboratorId)
    .eq("company_id", companyId)
    .maybeSingle();

  const skillsIndisponiveis = Boolean(absentError) && !isNoRowsError(absentError);
  if (skillsIndisponiveis) logQueryFailure("getSubstituteSuggestions:skills", absentError);

  const absentSkills: string[] = absent?.skills ?? [];

  // ── Fonte CRÍTICA: candidatas ─────────────────────────────────────────────
  const { data: allCollabs, error } = await admin
    .from("profiles")
    .select("id, full_name, skills, status")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .neq("id", collaboratorId)
    .in("role", ["colaborador", "gestor"]);

  if (error) return queryFailure("getSubstituteSuggestions:profiles", error);

  const collabIds = (allCollabs ?? []).map((c) => c.id);
  if (collabIds.length === 0) return { ok: true, data: [], rankingDegraded: skillsIndisponiveis };

  const [membershipsRes, absencesRes] = await Promise.all([
    admin
      .from("team_members")
      .select("collaborator_id, team_id")
      .in("collaborator_id", collabIds)
      .is("left_at", null),
    admin
      .from("absences")
      .select("collaborator_id")
      .eq("company_id", companyId)
      .in("collaborator_id", collabIds)
      .lte("starts_on", endsOn)
      .gte("ends_on", startsOn),
  ]);

  // ── Fonte CRÍTICA: faltas ─────────────────────────────────────────────────
  //
  // Sem isto não se sabe quem está ausente, e a resposta segura a "não sei se
  // ela pode ir" não é propô-la.
  if (absencesRes.error) {
    logQueryFailure("getSubstituteSuggestions:absences", absencesRes.error);
    return { ok: false, error: AVAILABILITY_UNCONFIRMED_MESSAGE };
  }

  // ── Fonte CRÍTICA: equipas ────────────────────────────────────────────────
  //
  // As equipas são o caminho até aos serviços. Se falharem, nenhuma candidata
  // tem equipa, nenhuma tem serviços, e todas parecem livres — a falha
  // disfarça-se de boa notícia.
  if (membershipsRes.error) {
    logQueryFailure("getSubstituteSuggestions:team_members", membershipsRes.error);
    return { ok: false, error: AVAILABILITY_UNCONFIRMED_MESSAGE };
  }

  const absentSet = new Set((absencesRes.data ?? []).map((a) => a.collaborator_id));

  const teamsByCollab = new Map<string, string[]>();
  for (const m of membershipsRes.data ?? []) {
    const list = teamsByCollab.get(m.collaborator_id) ?? [];
    list.push(m.team_id);
    teamsByCollab.set(m.collaborator_id, list);
  }

  // ── Fonte CRÍTICA: serviços ───────────────────────────────────────────────
  const allTeamIds = [...new Set((membershipsRes.data ?? []).map((m) => m.team_id))];
  const servicesByTeam = new Map<string, number>();
  if (allTeamIds.length > 0) {
    const { data: services, error: servicesError } = await admin
      .from("services")
      .select("team_id")
      .eq("company_id", companyId)
      .in("team_id", allTeamIds)
      .gte("scheduled_start", toLisbonTimestamp(startsOn, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(addDaysToDateString(endsOn, 1), "00:00"))
      .in("status", ["agendado", "em_curso"]);

    if (servicesError) {
      logQueryFailure("getSubstituteSuggestions:services", servicesError);
      return { ok: false, error: AVAILABILITY_UNCONFIRMED_MESSAGE };
    }

    for (const s of services ?? []) {
      if (!s.team_id) continue;
      servicesByTeam.set(s.team_id, (servicesByTeam.get(s.team_id) ?? 0) + 1);
    }
  }

  // ── Decidir, e só depois ordenar ──────────────────────────────────────────
  //
  // Elegibilidade primeiro, pontuação depois. Enquanto as duas estavam
  // misturadas, uma candidata sobre a qual não se sabia nada recebia um score
  // e entrava na lista pela porta do ranking.
  const suggestions: SubstituteSuggestion[] = [];

  for (const c of allCollabs ?? []) {
    const teams = teamsByCollab.get(c.id) ?? [];
    const conflictCount = teams.reduce((sum, tid) => sum + (servicesByTeam.get(tid) ?? 0), 0);

    const availability = resolveAvailability({
      isActive: c.status === "ativo",
      isAbsent: absentSet.has(c.id),
      conflictCount,
    });

    if (!isSuggestable(availability)) continue;

    const cSkills: string[] = c.skills ?? [];
    const commonSkills = cSkills.filter((sk) => absentSkills.includes(sk)).length;
    const score = commonSkills * 10 - conflictCount;

    suggestions.push({
      id: c.id,
      full_name: c.full_name,
      skills: cSkills,
      conflicting_services: conflictCount,
      score,
      availability,
    });
  }

  return {
    ok: true,
    data: suggestions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
    rankingDegraded: skillsIndisponiveis,
  };
}

