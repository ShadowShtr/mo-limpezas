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
  expected?: { updatedAt: string; leaderId: string | null; memberIds: string[] },
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

  if (teamId && !expected) {
    return { ok: false, error: "Atualize a página antes de guardar esta equipa." };
  }

  type TeamSaveRpc = (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  const rpc = admin.rpc.bind(admin) as unknown as TeamSaveRpc;
  const sortedMembers = [...new Set(memberIds)].sort();
  const { data: savedId, error: saveError } = await rpc("save_team_with_members_v2", {
    p_company_id: companyId,
    p_actor_id: user.id,
    p_team_id: teamId,
    p_expected_updated_at: expected?.updatedAt ?? null,
    p_expected_member_ids: [...(expected?.memberIds ?? [])].sort(),
    p_name: data.name,
    p_color: data.color,
    p_active: data.active,
    p_leader_id: data.leader_id,
    p_member_ids: sortedMembers,
  });

  if (saveError) {
    if (saveError.message?.includes("TEAM_SAVE_CONFLICT")) {
      return { ok: false, error: "Esta equipa foi alterada por outra pessoa. Atualize antes de guardar." };
    }
    if (saveError.message?.includes("TEAM_SAVE_MEMBER_IN_OTHER_TEAM")) {
      return { ok: false, error: "Uma das colaboradoras já pertence a outra equipa ativa." };
    }
    return { ok: false, error: "Não foi possível guardar a equipa." };
  }

  if (typeof savedId !== "string") {
    return { ok: false, error: "A base devolveu uma resposta incompleta." };
  }
  const savedTeamId = savedId;

  // A RPC preserva os intervalos de membership; a auditoria regista a mudança
  // funcional que a pessoa pediu, sem depender da forma como foi persistida.
  const before = expected
    ? { leader_id: expected.leaderId, memberIds: expected.memberIds }
    : null;
  const after = { leader_id: data.leader_id, memberIds: sortedMembers };
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
  revalidatePath("/dashboard/calendario");
  return { ok: true, teamId: savedTeamId };
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
