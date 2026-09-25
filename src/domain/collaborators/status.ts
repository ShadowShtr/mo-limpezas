/**
 * O estado de um colaborador — uma regra, num sítio.
 *
 * 🔴 PORQUE É QUE ISTO EXISTE.
 *
 *    A base aceita exactamente três estados, e diz-o num CHECK:
 *
 *        CHECK (status = ANY (ARRAY['ativo', 'inativo', 'suspenso']))
 *
 *    O runtime dizia outra coisa. `colaboradores.ts` validava contra
 *    `['ativo', 'inativo', 'arquivado']` e `create-input.ts` repetia a mesma
 *    lista — duas cópias da lista errada. O resultado media-se nos dois
 *    sentidos:
 *
 *      · `arquivado` passava a validação e era RECUSADO pela base, com o erro
 *        do Postgres a chegar cru à pessoa que estava a preencher o formulário;
 *      · `suspenso` EXISTE na base, o formulário oferecia-o, e a validação da
 *        criação recusava-o — um estado real que o produto não deixava criar.
 *
 *    Sete dos oito perfis não activos em produção estão exactamente em
 *    `suspenso`. A lista do runtime nunca soube da existência deles.
 *
 * 🔴 PORQUE É QUE A LISTA VIVE AQUI E NÃO EM CADA CONSUMIDOR.
 *
 *    Uma lista copiada é uma lista que diverge. A prova de que esta bate com a
 *    base não é este comentário: é um ensaio que lê o CHECK do catálogo de um
 *    Postgres real e o compara com `ESTADOS_COLABORADOR`.
 */

/**
 * Os três estados que a base aceita, por esta ordem.
 *
 * A ordem não é decorativa: é a ordem em que aparecem nos selectores, do mais
 * permissivo para o mais restritivo.
 */
export const ESTADOS_COLABORADOR = ["ativo", "inativo", "suspenso"] as const;

export type EstadoColaborador = (typeof ESTADOS_COLABORADOR)[number];

/**
 * O único estado que autoriza.
 *
 * 🔴 Desde a migration 106, `public.get_my_profile_id()` só resolve identidade
 *    quando `profiles.status = 'ativo'`. Esta constante é o lado do runtime da
 *    MESMA regra — não uma segunda regra paralela.
 *
 *    Escrito como comparação a um valor único, e não como «não está em
 *    inativo/suspenso»: um estado novo que a base viesse a aceitar amanhã
 *    ficaria de fora da autorização por omissão, que é o lado seguro. A lista
 *    de exclusão teria o comportamento contrário.
 */
export const ESTADO_AUTORIZADO: EstadoColaborador = "ativo";

/** O valor é um dos estados que a base aceita? */
export function isEstadoColaborador(v: unknown): v is EstadoColaborador {
  return typeof v === "string" &&
    (ESTADOS_COLABORADOR as readonly string[]).includes(v);
}

/**
 * Este perfil autoriza?
 *
 * 🔴 FAIL CLOSED. Um `status` ausente, nulo, ou fora dos três conhecidos NÃO
 *    autoriza. A alternativa — tratar o desconhecido como activo — daria
 *    acesso a quem tivesse um estado que este código ainda não conhece, que é
 *    precisamente o caso em que menos se sabe.
 */
export function estadoAutoriza(status: unknown): boolean {
  return status === ESTADO_AUTORIZADO;
}

/** Como se escreve cada estado na interface. */
export const ROTULO_ESTADO: Record<EstadoColaborador, string> = {
  ativo: "Ativo",
  inativo: "Inativo",
  suspenso: "Suspenso",
};

/**
 * O que dizer a quem entrou com sessão válida e já não tem acesso.
 *
 * 🔴 Uma pessoa suspensa que ainda tem o token no browser não é um erro
 *    técnico: é uma decisão de quem administra. Mostrar-lhe «Perfil não
 *    encontrado» seria mentir — o perfil existe — e mandá-la para um ecrã de
 *    erro cru deixá-la-ia a pensar que o sistema está avariado.
 */
export const MENSAGEM_SEM_ACESSO =
  "O seu acesso está desativado. Fale com quem administra o sistema.";
