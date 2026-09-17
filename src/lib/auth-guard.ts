import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MENSAGEM_SEM_ACESSO, perfilPodeEntrar } from "@/domain/collaborators/access-state";
import {
  MENSAGEM_FALHA_INFRA, RESOLUCAO_CODES, resolverPerfilAutenticado,
} from "@/lib/collaborators/current-profile-resolver";

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
  /**
   * 🔴 O perfil existe, a sessão é válida, e mesmo assim não passa.
   *
   *    Separado de `FORBIDDEN` porque não é a mesma coisa: `FORBIDDEN` é «não
   *    tens este papel», e resolve-se mudando o papel. Este é «já não
   *    trabalhas aqui», e a resposta certa é terminar a sessão, não explicar
   *    permissões.
   *
   *    Existe porque banir a conta no Auth não chega: o access token já
   *    emitido continua válido até ao `exp`, e sem esta verificação quem
   *    levasse saída continuava a escrever no sistema até lá.
   */
  INACTIVE: "INACTIVE",
  /**
   * 🔴 A base não respondeu — e isso NÃO é `PROFILE_NOT_FOUND`.
   *
   *    Separado porque as consequências são opostas: «não existe» é uma
   *    anomalia de dados que se investiga no perfil; isto é infraestrutura, e
   *    quem o vir tem de olhar para a base ou para a chave. Tratá-los como o
   *    mesmo mandava investigar o sítio errado — e já mandou, neste projeto.
   */
  PROFILE_LOOKUP_FAILED: "PROFILE_LOOKUP_FAILED",
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
  // 🔴 Pelo resolver, e não por um `select` próprio. Antes, `!profile` cobria
  //    «não existe» e «a leitura falhou» com a mesma resposta — e uma chave
  //    administrativa inválida saía daqui como perfil inexistente.
  const resolucao = await resolverPerfilAutenticado(admin, user.id);

  if (!resolucao.ok) {
    if (resolucao.codigo === RESOLUCAO_CODES.PROFILE_DB_FAILURE) {
      // Não se sabe. Não é «não existe», e não é «não autenticado».
      console.error("[requireProfile] perfil não resolvido", {
        userId: user.id, erro: resolucao.erro,
      });
      return {
        ok: false,
        code: AUTH_GUARD_CODES.PROFILE_LOOKUP_FAILED,
        error: MENSAGEM_FALHA_INFRA,
      };
    }
    return {
      ok: false,
      code: AUTH_GUARD_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }

  const profile = resolucao.perfil;

  // 🔴 O estado ANTES do papel, e de propósito.
  //
  //    Quem levou saída não deve receber «Sem permissão.» — essa mensagem
  //    descreve um papel insuficiente e manda a pessoa pedir mais acessos.
  //    Aqui o acesso acabou, e é isso que se diz.
  //
  //    Esta é a verificação que torna a saída IMEDIATA. As 27 actions que
  //    passam por `requireProfile` recusam no pedido seguinte, sem esperar
  //    que o token expire.
  if (!perfilPodeEntrar((profile as { status?: string | null }).status)) {
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

  return { ok: true, profile, admin };
}
