import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Verifica se um utilizador pode aceder a um serviço:
 * - admin/gestor: sim, se o serviço for da mesma empresa.
 * - colaboradora: apenas se for membro ativo da equipa ou reforço.
 *
 * Usar em qualquer route/action que receba um serviceId de input externo.
 */
export async function canAccessService(
  admin: AdminClient,
  userId: string,
  companyId: string,
  serviceId: string,
  role: string,
): Promise<boolean> {
  if (["admin", "gestor"].includes(role)) {
    const { count } = await admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("id", serviceId)
      .eq("company_id", companyId);
    return (count ?? 0) > 0;
  }

  const { data: svc } = await admin
    .from("services")
    .select("team_id, company_id")
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .single();
  if (!svc) return false;

  const [{ count: teamCount }, { count: reinfCount }] = await Promise.all([
    svc.team_id
      ? admin
          .from("team_members")
          .select("id", { count: "exact", head: true })
          .eq("team_id", svc.team_id)
          .eq("collaborator_id", userId)
          .is("left_at", null)
      : Promise.resolve({ count: 0 }),
    admin
      .from("service_reinforcements")
      .select("id", { count: "exact", head: true })
      .eq("service_id", serviceId)
      .eq("collaborator_id", userId),
  ]);

  return (teamCount ?? 0) > 0 || (reinfCount ?? 0) > 0;
}
