import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AuthedProfile {
  id: string;
  company_id: string;
  role: string;
}

type AdminClient = ReturnType<typeof createAdminClient>;

type GuardOk = {
  ok: true;
  profile: AuthedProfile;
  admin: AdminClient;
};
type GuardFail = { ok: false; error: string };

/**
 * Guarda de autenticação partilhada para server actions que usam o
 * service-role client (createAdminClient) — este faz bypass de RLS, por isso
 * a verificação de sessão + empresa + papel TEM de ser feita manualmente.
 *
 * Devolve sempre o `company_id` da sessão (nunca confiar num companyId vindo
 * do cliente) para garantir o isolamento multi-tenant.
 */
export async function requireProfile(
  opts?: { roles?: string[] },
): Promise<GuardOk | GuardFail> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile) return { ok: false, error: "Perfil não encontrado." };
  if (opts?.roles && !opts.roles.includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  return { ok: true, profile: profile as AuthedProfile, admin };
}
