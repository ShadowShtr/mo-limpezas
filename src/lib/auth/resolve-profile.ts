import type { createAdminClient } from "@/lib/supabase/admin";
import { estadoAutoriza } from "@/domain/collaborators/status";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * A resolução de identidade do runtime — uma, e igual à da base.
 *
 * 🔴 PORQUE É QUE ISTO NÃO PODE SER UM `.eq("id", user.id)`.
 *
 *    `criarAcesso()` cria a conta de Auth com um UUID NOVO e grava-o em
 *    `profiles.auth_user_id`. **Não** mexe em `profiles.id`. Portanto uma
 *    pessoa a quem se dê acesso hoje fica com:
 *
 *        profiles.id           != auth.uid()
 *        profiles.auth_user_id  = auth.uid()
 *
 *    Quatro sítios do runtime procuravam `profiles.id = user.id`. Para essa
 *    pessoa, todos devolveriam «perfil não encontrado» — e a base, que desde a
 *    101b resolve pelas duas convenções, encontrá-la-ia sem problema.
 *
 *    Hoje produção tem 29 ligações e todas as 29 ainda usam a convenção
 *    antiga. Isso não prova que o caminho novo funciona: prova que ainda não
 *    foi exercido. A primeira pessoa criada por este fluxo descobria-o.
 *
 * 🔴 A PRECEDÊNCIA É A DO `public.get_my_profile_id()`, INCLUINDO UM DETALHE
 *    QUE É FÁCIL PERDER.
 *
 *    A função da base, depois da 106, é:
 *
 *        SELECT id FROM profiles
 *         WHERE auth_user_id = auth.uid() AND status = 'ativo'
 *        UNION ALL
 *        SELECT id FROM profiles p
 *         WHERE p.id = auth.uid() AND p.status = 'ativo'
 *           AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
 *           AND NOT EXISTS (SELECT 1 FROM profiles x
 *                            WHERE x.auth_user_id = auth.uid())
 *        LIMIT 1;
 *
 *    O `NOT EXISTS` do ramo legado **não filtra por estado**. Quer dizer: se
 *    existir uma ligação explícita por `auth_user_id`, o ramo legado fica
 *    bloqueado mesmo que essa ligação esteja suspensa. A pessoa não «cai» para
 *    a linha antiga — fica sem identidade nenhuma.
 *
 *    Um `OR` entre as duas condições não reproduziria isto: devolveria a linha
 *    legada e daria acesso a quem a base recusa. É por isso que aqui são duas
 *    consultas com ordem, e não uma com `OR`.
 *
 * 🔴 PORQUE É QUE A PRIMEIRA CONSULTA NÃO FILTRA POR ESTADO.
 *
 *    Para poder distinguir «não há ligação» de «há ligação e não autoriza».
 *    São conclusões diferentes: a primeira permite o caminho legado, a segunda
 *    proíbe-o. Filtrar aqui apagaria a diferença e reabriria exactamente o
 *    buraco descrito acima.
 *
 * 🔴 O `EXISTS (auth.users)` do ramo legado não se repete aqui: o `authUid`
 *    chega de `supabase.auth.getUser()`, ou seja, de uma sessão verificada
 *    contra o Auth. A condição já está satisfeita por construção.
 */

/** Porque é que não há identidade. Códigos estáveis, para quem ramifica. */
export const MOTIVO_SEM_PERFIL = {
  /** Não existe linha nenhuma para esta conta, por nenhuma das convenções. */
  NAO_ENCONTRADO: "NAO_ENCONTRADO",
  /** A linha existe e o estado não autoriza. */
  INATIVO: "INATIVO",
  /** A consulta falhou. Não é o mesmo que «não existe» — ver abaixo. */
  ERRO_DE_LEITURA: "ERRO_DE_LEITURA",
} as const;

export type MotivoSemPerfil =
  (typeof MOTIVO_SEM_PERFIL)[keyof typeof MOTIVO_SEM_PERFIL];

export type ResolucaoDePerfil<T> =
  | { ok: true; perfil: T }
  | { ok: false; motivo: MotivoSemPerfil };

/**
 * O perfil da pessoa autenticada, pelas mesmas regras que a base usa.
 *
 * `campos` é a lista do `select`. `status` é acrescentado sempre, porque a
 * decisão depende dele — pedir uma lista sem ele não pode reabrir o acesso.
 */
export async function resolverPerfilAutenticado<T>(
  admin: AdminClient,
  authUid: string,
  campos: string,
): Promise<ResolucaoDePerfil<T>> {
  const select = campos.includes("status") ? campos : `${campos}, status`;

  // 1. A ligação explícita. Sem filtro de estado — ver o cabeçalho.
  const porLigacao = await admin
    .from("profiles")
    .select(select)
    .eq("auth_user_id", authUid)
    .maybeSingle();

  // 🔴 Um erro de leitura NÃO é «não existe».
  //
  //    Tratá-lo como ausência mandaria a pessoa para o caminho legado por
  //    causa de uma falha transitória — e, se a linha legada existisse e
  //    estivesse activa, dar-lhe-ia acesso que a base recusa. Fail closed.
  if (porLigacao.error) {
    return { ok: false, motivo: MOTIVO_SEM_PERFIL.ERRO_DE_LEITURA };
  }

  if (porLigacao.data) {
    const perfil = porLigacao.data as unknown as T;
    return estadoAutoriza((perfil as { status?: unknown }).status)
      ? { ok: true, perfil }
      // 🔴 Existe ligação e não autoriza: acaba aqui. NÃO se tenta o caminho
      //    legado, tal como o `NOT EXISTS` da função da base impede.
      : { ok: false, motivo: MOTIVO_SEM_PERFIL.INATIVO };
  }

  // 2. Só agora, e só porque não há ligação nenhuma: a convenção anterior à
  //    101b, em que o id do perfil ERA o id da conta de Auth.
  const legado = await admin
    .from("profiles")
    .select(select)
    .eq("id", authUid)
    .maybeSingle();

  if (legado.error) {
    return { ok: false, motivo: MOTIVO_SEM_PERFIL.ERRO_DE_LEITURA };
  }
  if (!legado.data) {
    return { ok: false, motivo: MOTIVO_SEM_PERFIL.NAO_ENCONTRADO };
  }

  const perfil = legado.data as unknown as T;
  return estadoAutoriza((perfil as { status?: unknown }).status)
    ? { ok: true, perfil }
    : { ok: false, motivo: MOTIVO_SEM_PERFIL.INATIVO };
}
