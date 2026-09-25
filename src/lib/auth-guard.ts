import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MENSAGEM_SEM_ACESSO } from "@/domain/collaborators/status";
import {
  resolverPerfilAutenticado, MOTIVO_SEM_PERFIL,
} from "@/lib/auth/resolve-profile";

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
  INACTIVE: "INACTIVE",
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

  // 🔴 A resolucao de identidade e a MESMA da base, e vive num sitio so.
  //
  //    Isto era `.eq("id", user.id)`. `criarAcesso()` grava a conta nova em
  //    `auth_user_id` e NAO mexe em `profiles.id`: para quem receba acesso a
  //    partir de agora, procurar pelo `id` nao encontra ninguem — enquanto a
  //    base, que resolve pelas duas convencoes desde a 101b, encontra.
  const r = await resolverPerfilAutenticado<AuthedProfile>(
    admin, user.id, "id, company_id, role");

  if (!r.ok) {
    // 🔴 Um erro de leitura nao e um perfil inexistente, e nao e um perfil
    //    inactivo. Sao tres conclusoes diferentes e ficam com codigos
    //    diferentes — quem ramifica por `guard.code` precisa da distincao.
    if (r.motivo === MOTIVO_SEM_PERFIL.INATIVO) {
      return {
        ok: false,
        code: AUTH_GUARD_CODES.INACTIVE,
        error: MENSAGEM_SEM_ACESSO,
      };
    }
    return {
      ok: false,
      code: AUTH_GUARD_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }

  const profile = r.perfil;

  if (opts?.roles && !opts.roles.includes(profile.role)) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.FORBIDDEN,
      error: "Sem permissão.",
    };
  }

  return { ok: true, profile: profile as AuthedProfile, admin };
}
