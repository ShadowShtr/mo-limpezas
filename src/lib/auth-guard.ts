import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveProfileByAuthUser, IDENTITY_CODES, type IdentityCode } from "@/lib/identity";

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
  /** A consulta de identidade falhou — não é o mesmo que não haver perfil. */
  IDENTITY_LOOKUP_FAILED: "IDENTITY_LOOKUP_FAILED",
  /** Dois perfis ligados à mesma conta de acesso. Nunca escolher um. */
  IDENTITY_AMBIGUOUS: "IDENTITY_AMBIGUOUS",
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
 * Tradução dos motivos do resolver para os códigos do guard.
 *
 * É um mapa e não uma cadeia de ternários porque o `Record` obriga o
 * compilador a exigir uma entrada por cada `IdentityCode`: um motivo novo no
 * resolver parte a compilação em vez de cair em silêncio num ramo genérico.
 */
const CODIGO_DE_IDENTIDADE: Record<IdentityCode, AuthGuardCode> = {
  [IDENTITY_CODES.IDENTITY_LOOKUP_FAILED]: AUTH_GUARD_CODES.IDENTITY_LOOKUP_FAILED,
  [IDENTITY_CODES.IDENTITY_AMBIGUOUS]: AUTH_GUARD_CODES.IDENTITY_AMBIGUOUS,
  [IDENTITY_CODES.PROFILE_NOT_FOUND]: AUTH_GUARD_CODES.PROFILE_NOT_FOUND,
};

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

  // `auth.uid()` → `profiles.auth_user_id` → `profiles.id`. A consulta antiga
  // era `profiles.id = user.id`, que só funciona enquanto o id do perfil e o
  // da conta forem o mesmo valor — e deixa de funcionar na primeira pessoa a
  // quem se dê acesso depois de o perfil já existir. Ver `lib/identity.ts`.
  const identidade = await resolveProfileByAuthUser(admin, user.id);
  if (!identidade.ok) {
    return { ok: false, code: CODIGO_DE_IDENTIDADE[identidade.code], error: identidade.error };
  }
  const profile = identidade.profile;

  if (opts?.roles && !opts.roles.includes(profile.role)) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.FORBIDDEN,
      error: "Sem permissão.",
    };
  }

  return { ok: true, profile: profile as AuthedProfile, admin };
}
