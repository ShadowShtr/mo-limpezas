import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  estadoAutoriza, MENSAGEM_SEM_ACESSO,
} from "@/domain/collaborators/status";

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
  const { data: profile } = await admin
    .from("profiles")
    .select("id, company_id, role, status")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }

  // 🔴 O ESTADO, ANTES DO PAPEL.
  //
  //    `createAdminClient()` é service_role, e service_role tem BYPASSRLS: as
  //    políticas que a migration 106 fechou NÃO se aplicam a nada do que passa
  //    por aqui. Sem esta verificação, uma pessoa suspensa com o token ainda
  //    válido continuava a executar todas as server actions do produto — a
  //    base dizia-lhe que não e o runtime passava-lhe por cima.
  //
  //    Não é uma segunda regra: é a MESMA regra, do lado que a RLS não alcança.
  //    A base continua a ser a fonte; `ESTADO_AUTORIZADO` e o filtro do
  //    resolver são o mesmo valor, e há um ensaio que o prova contra o CHECK
  //    vivo.
  //
  //    Vem antes do papel de propósito: quem não tem acesso nenhum não deve
  //    receber «Sem permissão», que sugere que outro papel resolveria.
  if (!estadoAutoriza(profile.status)) {
    return {
      ok: false,
      code: AUTH_GUARD_CODES.INACTIVE,
      error: MENSAGEM_SEM_ACESSO,
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
