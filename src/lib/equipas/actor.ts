// ============================================================================
// Quem está a agir — resolvido pela ligação, não pela coincidência
// ============================================================================
//
// 🔴 `profiles.id` NÃO é o id do utilizador de autenticação.
//
//    Hoje coincidem para toda a gente, porque as contas actuais nasceram todas
//    do mesmo trigger. Mas `profiles.auth_user_id` existe precisamente porque a
//    ligação é uma coisa separada: uma pessoa pode ter ficha sem login (é o
//    caso desde a frente da identidade da colaboradora), e uma ficha criada à
//    mão recebe um `id` gerado no servidor que nada tem que ver com o `auth`.
//
//    Código que faz `.eq("id", user.id)` funciona por acidente. No dia em que
//    alguém criar uma ficha primeiro e a conta depois, esse código deixa de
//    encontrar a pessoa — e o modo de falha é «sem permissão», que manda quem
//    investiga procurar no sítio errado.
//
// 🔴 O `fallback` pelo `id` fica, e é deliberado.
//
//    Retirá-lo agora partiria o login de toda a gente cujo `auth_user_id`
//    ainda é NULL — que é a maioria. A ordem certa é: preferir a ligação
//    explícita, aceitar a coincidência histórica, e não fingir que a segunda
//    não existe. Quando `auth_user_id` estiver preenchido em toda a base, o
//    fallback sai numa alteração própria, com a sua prova.
//
// Âmbito: esta frente (Equipas R4). NÃO é um refactor global de autenticação.
// ============================================================================

/** O actor de domínio: o `profiles.id`, que é o que a auditoria regista. */
export interface ActorEquipas {
  profileId: string;
  companyId: string;
  role: string;
}

interface ClienteActor {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => PromiseLike<{
          data: { id: string; company_id: string; role: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

export type ResolucaoActor =
  | { ok: true; actor: ActorEquipas }
  | { ok: false; motivo: "SEM_SESSAO" | "SEM_PERFIL" | "SEM_PERMISSAO" | "ERRO_LEITURA"; error: string };

const PAPEIS_DE_GESTAO = ["admin", "gestor"];

/**
 * Resolve o actor a partir do id de autenticação.
 *
 * Duas leituras, por esta ordem, e a razão da ordem importa: se as duas
 * pudessem responder, a ligação explícita é a verdade e a coincidência é o
 * acidente.
 */
export async function resolverActorEquipas(
  admin: unknown,
  authUserId: string | null | undefined,
): Promise<ResolucaoActor> {
  if (!authUserId) {
    return { ok: false, motivo: "SEM_SESSAO", error: "Não autenticado." };
  }

  const cliente = admin as ClienteActor;
  const colunas = "id, company_id, role";

  for (const coluna of ["auth_user_id", "id"] as const) {
    const { data, error } = await cliente
      .from("profiles").select(colunas).eq(coluna, authUserId).maybeSingle();

    // 🔴 Um erro de leitura NÃO é «não encontrei». Tratá-los como o mesmo caso
    //    transformaria uma falha de rede numa mensagem de falta de permissão, e
    //    a pessoa passaria a ver «sem permissão» por causa da base estar em
    //    baixo. Falha fechado, mas com o motivo certo.
    if (error) {
      return {
        ok: false,
        motivo: "ERRO_LEITURA",
        error: "Não foi possível confirmar a sua conta. Nada foi alterado.",
      };
    }

    if (data) {
      if (!PAPEIS_DE_GESTAO.includes(data.role)) {
        return { ok: false, motivo: "SEM_PERMISSAO", error: "Sem permissão." };
      }
      return {
        ok: true,
        actor: { profileId: data.id, companyId: data.company_id, role: data.role },
      };
    }
  }

  return { ok: false, motivo: "SEM_PERFIL", error: "Perfil não encontrado." };
}
