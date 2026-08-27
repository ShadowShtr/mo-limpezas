"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";

export async function saveEquipa(
  teamId: string | null,
  companyId: string,
  data: { name: string; color: string; active: boolean; leader_id: string | null },
  memberIds: string[],
): Promise<{ ok: true; teamId: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const admin = createAdminClient();

  // Verificar permissão
  const { data: profile } = await admin
    .from("profiles")
    .select("role, company_id")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }
  if (profile.company_id !== companyId) {
    return { ok: false, error: "Empresa inválida." };
  }

  let savedTeamId = teamId;

  // Estado antigo (líder + membros), só para auditoria — nunca bloqueia a
  // operação se falhar.
  let before: { leader_id: string | null; memberIds: string[] } | null = null;
  if (teamId) {
    const [{ data: oldTeam }, { data: oldMembers }] = await Promise.all([
      admin.from("teams").select("leader_id").eq("id", teamId).single(),
      admin.from("team_members").select("collaborator_id").eq("team_id", teamId),
    ]);
    before = { leader_id: oldTeam?.leader_id ?? null, memberIds: (oldMembers ?? []).map((m) => m.collaborator_id) };
  }

  if (teamId) {
    const { error } = await admin
      .from("teams")
      .update(data)
      .eq("id", teamId)
      .eq("company_id", companyId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data: newTeam, error } = await admin
      .from("teams")
      .insert({ ...data, company_id: companyId })
      .select("id")
      .single();
    if (error || !newTeam) return { ok: false, error: error?.message ?? "Erro ao criar equipa." };
    savedTeamId = newTeam.id;
  }

  // Substituir membros — usar admin para garantir que não falha por RLS
  const { error: delError } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", savedTeamId!);

  if (delError) return { ok: false, error: delError.message };

  if (memberIds.length > 0) {
    const { error: insError } = await admin
      .from("team_members")
      .insert(memberIds.map((cid) => ({ team_id: savedTeamId!, collaborator_id: cid })));
    if (insError) return { ok: false, error: insError.message };
  }

  // Auditoria de líder/membros — a operação substitui a equipa toda
  // (delete + reinsert); sem isto não há como ver quem foi removido.
  const after = { leader_id: data.leader_id, memberIds };
  if (!before || before.leader_id !== after.leader_id ||
    before.memberIds.length !== after.memberIds.length ||
    !before.memberIds.every((m) => after.memberIds.includes(m))) {
    await auditLog({
      companyId,
      actorId: user.id,
      action: "equipa_lider_membros_alterados",
      entityType: "team",
      entityId: savedTeamId!,
      before: before ?? { leader_id: null, memberIds: [] },
      after,
      source: "dashboard",
    }, admin);
  }

  revalidatePath("/dashboard/equipas");
  return { ok: true, teamId: savedTeamId! };
}

export async function deleteEquipa(
  teamId: string,
  companyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, company_id")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }
  if (profile.company_id !== companyId) {
    return { ok: false, error: "Empresa inválida." };
  }

  // FKs: team_members e vehicle_allocations fazem CASCADE; services.team_id fica
  // a NULL (serviços ficam "sem equipa"). Não perde os serviços.
  const { error } = await admin
    .from("teams")
    .delete()
    .eq("id", teamId)
    .eq("company_id", companyId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/equipas");
  revalidatePath("/dashboard/calendario");
  return { ok: true };
}
