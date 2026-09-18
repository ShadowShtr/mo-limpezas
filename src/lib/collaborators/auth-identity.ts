// ============================================================================
// A ponte entre um perfil e a conta de acesso dele — um sítio só
// ============================================================================
//
// 🔴 Porque é que isto tinha de existir antes de mais alguma coisa.
//
//    O repositório tem DUAS arquiteturas de identidade a coexistir, e o
//    código estava escrito metade para cada uma:
//
//      · o modelo LEGADO, que é o que produção corre hoje: o perfil e a conta
//        partilham o `id` (`profiles.id = auth.users.id`, com a FK em
//        CASCADE). `getCurrentProfile`, o proxy e o layout do dashboard
//        procuram o perfil por `id = user.id`, e funciona porque são o mesmo
//        número;
//
//      · o modelo SEPARADO, para onde o projeto já decidiu ir: criar uma
//        pessoa não cria conta nenhuma, e a ligação vive em
//        `profiles.auth_user_id`. `collaborator-access.ts` já está escrito
//        assim. A migration que cria a coluna está em
//        `supabase/migrations/draft/PROVISIONAL_collaborator_identity_expand.sql`
//        — ou seja, ainda não entrou.
//
//    `desativarColaborador`, acabada de escrever, chamava
//    `getUserById(profileId)` — escolhendo o modelo legado sem o dizer, na
//    mesma sessão em que outra action ao lado escolhia o outro. Duas regras a
//    fingir que são uma.
//
//    Isto não é preciosismo de arquitetura. No dia em que a coluna entrar, um
//    `getUserById(profileId)` esquecido num canto passa a banir a conta
//    errada, ou conta nenhuma, e a pessoa que levou saída continua a entrar.
//
// Este módulo é o único sítio onde a regra vive. Enquanto a coluna não
// existir, ele representa o legado EXPLICITAMENTE — `origem: "legado"` — e
// não por omissão. Quando a migration entrar, muda-se aqui, e só aqui.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * De onde saiu o id da conta.
 *
 * Faz parte do resultado, e não é decoração: quem audita uma desativação tem
 * de conseguir dizer se o sistema seguiu a coluna ou a regra antiga, e um
 * ensaio tem de conseguir afirmar qual dos dois mundos está a medir.
 */
export type OrigemIdentidade = "coluna" | "legado";

export type IdentidadeAuth =
  | { ok: true; authUserId: string | null; origem: OrigemIdentidade }
  | { ok: false; erro: string };

/**
 * O PostgREST a dizer «essa coluna não existe».
 *
 * 🔴 Distinguir isto de uma falha real é o miolo deste ficheiro. Tratar
 *    qualquer erro como «então é o modelo legado» faria uma base em baixo
 *    parecer uma base antiga, e a operação seguiria com o id errado. Só
 *    `42703` — undefined_column — autoriza o caminho legado.
 */
function colunaInexistente(error: { code?: string; message?: string }): boolean {
  if (error.code === "42703") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("auth_user_id") && (m.includes("does not exist") || m.includes("column"));
}

/**
 * O id da conta de acesso desta pessoa, seja qual for o modelo em vigor.
 *
 * `authUserId: null` significa «esta pessoa não tem conta» — legítimo desde
 * que criar um colaborador deixou de criar um utilizador. Não é erro, e quem
 * chama tem de o tratar como «não há acesso para retirar», nunca como falha.
 */
export async function resolverIdentidadeAuth(
  admin: AdminClient,
  profileId: string,
): Promise<IdentidadeAuth> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, auth_user_id")
    .eq("id", profileId)
    .maybeSingle();

  if (error) {
    if (!colunaInexistente(error)) return { ok: false, erro: error.message };

    // Modelo legado: a coluna ainda não existe nesta base. A regra é
    // `profiles.id = auth.users.id`, e fica dita em voz alta.
    const legado = await admin
      .from("profiles")
      .select("id")
      .eq("id", profileId)
      .maybeSingle();
    if (legado.error) return { ok: false, erro: legado.error.message };
    if (!legado.data) return { ok: false, erro: "Perfil não encontrado." };
    return { ok: true, authUserId: (legado.data as { id: string }).id, origem: "legado" };
  }

  if (!data) return { ok: false, erro: "Perfil não encontrado." };

  const linha = data as { id: string; auth_user_id?: string | null };

  // A coluna existe. Uma pessoa sem conta tem `auth_user_id` a NULL — e é
  // isso que se devolve, não o `id` do perfil. Cair para o `id` aqui seria
  // reintroduzir o modelo legado por baixo do novo, que é exactamente a
  // confusão que este ficheiro existe para acabar.
  return { ok: true, authUserId: linha.auth_user_id ?? null, origem: "coluna" };
}
