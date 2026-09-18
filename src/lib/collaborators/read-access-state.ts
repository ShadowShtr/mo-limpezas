// ============================================================================
// O estado de acesso, lido das fontes que decidem
// ============================================================================
//
// 🔴 A ficha do colaborador mostrava um estado que não podia estar certo.
//
//    Chamava `estadoAcesso(pessoa, { must_change_password })` — sem `disabled`.
//    O `disabled` é o banimento no Auth, e a página nunca o lia. Consequência:
//    «desativado» era INALCANÇÁVEL naquele ecrã, o botão «Reativar acesso»
//    nunca aparecia, e o cartão podia dizer «Ativo» ao lado de um perfil
//    marcado como Inativo na mesma página.
//
//    Um estado de interface derivado de um campo que ninguém carregou não é um
//    estado: é um valor por omissão com aspecto de facto.
//
// Este módulo vai buscar as duas fontes que decidem mesmo:
//
//   · `profiles.status`  — o que a aplicação e a RLS consultam (101c);
//   · o banimento no Auth — o que impede um login novo.
//
// E devolve-as juntas, para a interface poder dizer a verdade.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";
import {
  estadoAcesso, type EstadoAcesso, type Pessoa,
} from "@/domain/collaborators/access-lifecycle";
import { resolverIdentidadeAuth } from "@/lib/collaborators/auth-identity";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Lê o estado de acesso de uma pessoa.
 *
 * Nunca lança: a ficha do colaborador não pode rebentar porque o Auth demorou
 * a responder. Quando não se consegue confirmar o banimento, o `status` decide
 * sozinho — e é a fonte mais restritiva das duas, por isso o erro é para o
 * lado seguro.
 */
export async function lerEstadoDeAcesso(
  admin: AdminClient,
  pessoa: Pessoa,
  status: string | null,
): Promise<EstadoAcesso> {
  if (pessoa.auth_user_id === null) return "sem_acesso";

  let contaBanida = false;
  let trocaPendente = false;

  try {
    const identidade = await resolverIdentidadeAuth(admin, pessoa.id);
    if (identidade.ok && identidade.authUserId) {
      const { data } = await admin.auth.admin.getUserById(identidade.authUserId);
      // `banned_until` é como o Supabase representa o banimento. Uma data no
      // passado não é banimento nenhum.
      const ate = (data?.user as { banned_until?: string | null } | undefined)?.banned_until;
      contaBanida = Boolean(ate && new Date(ate).getTime() > Date.now());
    }
  } catch {
    // Fica `false`, e o `status` decide. Ver a nota acima.
  }

  const { data: perfil } = await admin
    .from("profiles").select("must_change_password").eq("id", pessoa.id).maybeSingle();
  trocaPendente = Boolean((perfil as { must_change_password?: boolean } | null)?.must_change_password);

  return estadoAcesso(
    pessoa,
    { disabled: contaBanida, must_change_password: trocaPendente },
    status,
  );
}
