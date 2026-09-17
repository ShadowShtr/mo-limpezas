// ============================================================================
// Quem está a pedir — uma resposta, com a razão quando não há
// ============================================================================
//
// 🔴 O padrão que este ficheiro acaba.
//
//    Havia quatro sítios a responder à mesma pergunta, cada um à sua maneira,
//    e três deles a perder a razão pelo caminho:
//
//      · `requireProfile`      → devolvia PROFILE_NOT_FOUND para `!profile`;
//      · `resolverActor`       → devolvia `null`, e as actions traduziam para
//                                «Não autenticado.»;
//      · `carregarPessoa`      → devolvia `null` (corrigido na 102.2b);
//      · `getCurrentProfile`   → devolvia `null`, e os layouts terminavam a
//                                sessão.
//
//    O denominador comum é `.single()`/`.maybeSingle()` devolverem `data:
//    null` TANTO para «não existe» como para «a leitura falhou», e só o
//    `data` ser lido. Um timeout, um `08006`, uma chave administrativa
//    inválida — tudo indistinguível de um perfil inexistente.
//
//    `resolverActor` era o pior dos quatro: uma falha de infraestrutura saía
//    como «Não autenticado.», que manda quem administra procurar a sessão em
//    vez da base. Foi exactamente assim que um incidente antigo deste projeto
//    demorou a ser lido — a chave de serviço estava inválida e o sintoma era
//    um ciclo de login.
//
//    Três estados, três nomes:
//
//      AUTH_MISSING       — não há sessão. Legítimo, e o login trata disso.
//      PROFILE_MISSING    — há sessão e não há perfil. Anomalia de dados.
//      PROFILE_DB_FAILURE — não se sabe. Nunca se traduz para um dos outros.
//
//    DB_FAILURE != PROFILE_NOT_FOUND != UNAUTHENTICATED.
//    UNKNOWN_STATE = FAIL_CLOSED.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";
import { isNoRowsError } from "@/lib/query-error";

type AdminClient = ReturnType<typeof createAdminClient>;

/** As colunas que qualquer decisão de autorização precisa. */
export interface PerfilAutenticado {
  id: string;
  company_id: string;
  role: string;
  status: string | null;
  /**
   * A ligação à conta de acesso.
   *
   * 🔴 Faz parte do perfil e não se resolve aqui por atalho: produção tem hoje
   *    `auth_user_id = id` em todas as contas ligadas, e um resolver que
   *    assumisse isso partiria no dia em que deixasse de ser verdade. Quem
   *    precisa do id da conta usa `resolverIdentidadeAuth`.
   */
  auth_user_id: string | null;
}

export const RESOLUCAO_CODES = {
  AUTH_MISSING: "AUTH_MISSING",
  PROFILE_MISSING: "PROFILE_MISSING",
  PROFILE_DB_FAILURE: "PROFILE_DB_FAILURE",
} as const;

export type ResolucaoCode = (typeof RESOLUCAO_CODES)[keyof typeof RESOLUCAO_CODES];

export type ResolucaoPerfil =
  | { ok: true; perfil: PerfilAutenticado; authUserId: string }
  | { ok: false; codigo: ResolucaoCode; erro: string };

/** O que se diz quando a base não respondeu. Nunca inventa uma causa. */
export const MENSAGEM_FALHA_INFRA =
  "Não foi possível confirmar a tua sessão neste momento. Nada foi alterado — tenta outra vez.";

/**
 * Resolve o perfil de um utilizador já autenticado.
 *
 * Recebe o `authUserId` em vez de o ir buscar: quem chama já falou com o Auth,
 * e ir lá outra vez duplicaria o pedido em cada action. A ausência de sessão é
 * decidida por quem chama e comunicada com `AUTH_MISSING`.
 *
 * 🔴 Procura por `id` e por `auth_user_id`, porque o projeto tem os dois
 *    modelos de identidade a coexistir — tal como `get_my_profile_id()` faz na
 *    base desde a 102. Hoje, em produção, dão o mesmo perfil; no dia em que
 *    deixarem de dar, esta função continua certa e as actions não precisam de
 *    saber nada sobre isso.
 */
export async function resolverPerfilAutenticado(
  admin: AdminClient,
  authUserId: string,
): Promise<ResolucaoPerfil> {
  // 🔴 Por `id` PRIMEIRO, e isso é uma decisão, não um acaso.
  //
  //    Duas razões, e ambas foram aprendidas à custa:
  //
  //    1. É o modelo que produção tem. `auth_user_id != id` = 0 linhas (lido
  //       read-only), por isso esta consulta resolve TODOS os casos reais. Pôr
  //       `auth_user_id` à frente acrescentava uma segunda ida à base em cada
  //       pedido autenticado — 27 actions, todos os pedidos, para nunca
  //       encontrar nada de diferente.
  //
  //    2. `profiles.auth_user_id` NÃO é criada por nenhuma migration aplicada
  //       deste repositório: vive em `supabase/migrations/draft/` e chegou a
  //       produção por fora. O incidente #86 foi exactamente um caminho de
  //       autenticação a passar a exigir essa coluna antes de ela existir —
  //       ninguém entrou, admin incluído. O caminho principal não pode
  //       depender dela.
  const porId = await admin
    .from("profiles")
    .select("id, company_id, role, status, auth_user_id")
    .eq("id", authUserId)
    .single();

  // 🔴 `.single()` + `isNoRowsError`, e não `.maybeSingle()`.
  //
  //    É o padrão desta base de código para separar «não há linha» de «a
  //    leitura falhou» — o mesmo que `resolverAlvoDeSaida` usa. `maybeSingle`
  //    achata os dois num `data: null`, que é precisamente a confusão que este
  //    ficheiro existe para acabar.
  if (porId.error && !isNoRowsError(porId.error) && !colunaAuthUserIdAusente(porId.error)) {
    return { ok: false, codigo: RESOLUCAO_CODES.PROFILE_DB_FAILURE, erro: porId.error.message };
  }

  // A coluna não existe nesta base: repete-se sem ela. As listas de colunas
  // são literais e não uma variável porque o cliente do Supabase é tipado
  // contra o texto do `select`.
  const semColuna = porId.error && colunaAuthUserIdAusente(porId.error)
    ? await admin.from("profiles")
        .select("id, company_id, role, status").eq("id", authUserId).single()
    : null;
  if (semColuna?.error && !isNoRowsError(semColuna.error)) {
    return { ok: false, codigo: RESOLUCAO_CODES.PROFILE_DB_FAILURE, erro: semColuna.error.message };
  }

  const linha = (semColuna?.data ?? porId.data) as
    (Partial<PerfilAutenticado> & { id: string }) | null;

  if (linha) {
    return {
      ok: true,
      perfil: {
        id: linha.id,
        company_id: linha.company_id as string,
        role: linha.role as string,
        status: linha.status ?? null,
        auth_user_id: linha.auth_user_id ?? null,
      },
      authUserId,
    };
  }

  // Só aqui — quando não há perfil com este `id` — é que faz sentido perguntar
  // pela outra metade do modelo de identidade. É o caso que existirá no dia em
  // que o perfil e a conta deixarem de partilhar o número; hoje não devolve
  // nada, e custa uma consulta apenas quando já se ia falhar.
  if (!porId.error || isNoRowsError(porId.error)) {
    const porColuna = await admin
      .from("profiles")
      .select("id, company_id, role, status, auth_user_id")
      .eq("auth_user_id", authUserId)
      .single();

    if (porColuna.error && !isNoRowsError(porColuna.error)
        && !colunaAuthUserIdAusente(porColuna.error)) {
      return {
        ok: false, codigo: RESOLUCAO_CODES.PROFILE_DB_FAILURE, erro: porColuna.error.message,
      };
    }
    if (porColuna.data) {
      return { ok: true, perfil: porColuna.data as PerfilAutenticado, authUserId };
    }
  }

  return {
    ok: false,
    codigo: RESOLUCAO_CODES.PROFILE_MISSING,
    erro: "Perfil não encontrado.",
  };
}

/** O PostgREST a dizer que `auth_user_id` não existe nesta base. */
function colunaAuthUserIdAusente(error: { code?: string; message?: string }): boolean {
  if (error.code === "42703") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("auth_user_id") && (m.includes("does not exist") || m.includes("column"));
}
