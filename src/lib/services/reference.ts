import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Nº de colaboradoras ativas de uma equipa (membros sem `left_at`).
 * Devolve 1 se a equipa não existir/estiver vazia ou se teamId for null.
 */
export async function getTeamSize(admin: AdminClient, teamId: string | null): Promise<number> {
  if (!teamId) return 1;
  const { count } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .is("left_at", null);
  return count && count > 0 ? count : 1;
}

/**
 * Maior número de referência numérico já usado pela empresa.
 * Baseia a próxima referência no MÁXIMO (não em count(*)): com count(*), serviços
 * apagados/cancelados criam buracos e count fica abaixo do máximo, fazendo
 * count+1 colidir com referências já existentes (erro de unicidade).
 *
 * Lê um lote dos mais recentes e calcula o máximo numérico em JS (robusto à
 * transição de 4 para 5 dígitos, ao contrário de uma ordenação lexical).
 */
export async function maxReferenceNumber(admin: AdminClient, companyId: string): Promise<number> {
  const { data } = await admin
    .from("services")
    .select("reference_number")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(500);
  let max = 0;
  for (const r of data ?? []) {
    const n = parseInt(r.reference_number, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
