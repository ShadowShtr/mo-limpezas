import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AuthedProfile {
  id: string;
  company_id: string;
  role: string;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Motivos de recusa, com código estável.
 *
 * Existe para uma action poder ramificar por `guard.code` em vez de comparar
 * `guard.error` como texto — comparar mensagens torna a lógica refém da
 * redação, e a mensagem que o utilizador deve ver depende da action (a de
 * configurações diz "Sem permissão para alterar configurações.", não
 * "Sem permissão.").
 */
export const AUTH_GUARD_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
} as const;

export type AuthGuardCode =
  (typeof AUTH_GUARD_CODES)[keyof typeof AUTH_GUARD_CODES];

type GuardOk = {
  ok: true;
  profile: AuthedProfile;
  admin: AdminClient;
};

/**
 * `error` é mantido de propósito: dezenas de actions ainda fazem
 * `return { ok: false, error: guard.error }`. Sai quando a migração para
 * `ActionResult` (Task T05) terminar, não antes.
 */
type GuardFail = { ok: false; code: AuthGuardCode; error: string };

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
  if (!user) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.UNAUTHENTICATED,
      error: "Não autenticado.",
    };
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, company_id, role")
    .eq("auth_user_id", user.id)
    .single();

  if (!profile) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }

  if (opts?.roles && !opts.roles.includes(profile.role)) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.FORBIDDEN,
      error: "Sem permissão.",
    };
  }

  return { ok: true, profile: profile as AuthedProfile, admin };
}
