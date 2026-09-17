// ============================================================================
// Quem pode entrar — a regra, num sítio só
// ============================================================================
//
// 🔴 O buraco que este ficheiro fecha.
//
//    «Dar saída» banía a conta no Auth e marcava `status = 'inativo'`. A
//    interface prometia «a pessoa deixa de entrar». Era forte demais, e por
//    duas razões independentes:
//
//      · `profiles.status` não é lido por política RLS nenhuma — zero de 93.
//        Marcar inativo não fechava porta nenhuma na base;
//
//      · banir no Supabase impede um login NOVO. Não invalida o access token
//        já emitido, que continua a ser aceite até ao `exp`. Quem estivesse
//        autenticado no momento da saída continuava a trabalhar — a escrever
//        pontos, a fechar serviços, a mexer no financeiro — durante o resto
//        da validade do token.
//
//    O banimento é necessário (fecha o login seguinte) e não é suficiente. O
//    que torna a saída imediata é o estado do perfil passar a ser consultado
//    em cada pedido, no caminho que decide autorização: `requireProfile`, o
//    layout do dashboard, o layout da app e o proxy. Todos leem daqui.
//
// ----------------------------------------------------------------------------
// Uma lista de quem ENTRA, e não de quem não entra
// ----------------------------------------------------------------------------
//
// 🔴 A primeira versão desta regra era uma lista de exclusão: entrava tudo
//    menos `inativo`, `suspenso` e `arquivado`. `null`, vazio e qualquer
//    estado desconhecido passavam.
//
//    O argumento era defensável — `status` é anulável, e fechar na ausência
//    podia trancar fora quem nunca teve o estado escrito. Mas era um receio,
//    não um facto, e a direcção mandou medi-lo. Medido (leitura read-only de
//    produção): `status` NULL = 0 linhas, vazio = 0 linhas, e o `CHECK` da
//    base só admite `ativo | inativo | suspenso`.
//
//    Ou seja: o caso que a lista de exclusão protegia não existe, e em troca
//    ela deixava entrar qualquer estado novo que alguém inventasse — em
//    silêncio, que é exactamente como um buraco de acesso nasce.
//
//    `UNKNOWN_STATE = FAIL_CLOSED`. Entra quem está explicitamente activo.
//
//    Esta regra é a MESMA que a migration 102 põe em `get_my_profile_id()`
//    (`status = 'ativo'`). Duas camadas, uma regra — se divergirem, a
//    aplicação e a base passam a discordar sobre quem trabalha aqui.
// ============================================================================

/** O único estado que dá acesso. */
export const ESTADO_ATIVO = "ativo";

/**
 * Os estados que significam «esta pessoa já não trabalha aqui».
 *
 * 🔴 Já não é isto que decide o acesso — `perfilPodeEntrar` compara com
 *    `ESTADO_ATIVO`. Fica porque continua a ser útil para NOMEAR uma saída
 *    (e o ensaio obriga `ESTADO_DE_SAIDA` a estar cá dentro), mas quem
 *    acrescentar um estado novo a esta lista não muda o acesso: um estado
 *    desconhecido já não entra, esteja ou não aqui.
 */
export const ESTADOS_SEM_ACESSO = ["inativo", "suspenso", "arquivado"] as const;

export type EstadoSemAcesso = (typeof ESTADOS_SEM_ACESSO)[number];

/** O estado que `desativarColaborador` escreve. Um só, e nomeado. */
export const ESTADO_DE_SAIDA: EstadoSemAcesso = "inativo";

/**
 * Esta pessoa pode usar o sistema?
 *
 * Só o estado. Não decide papéis nem empresa — quem chama já o fez, e
 * misturar as três decisões numa função só tornaria impossível dizer qual
 * delas recusou.
 *
 * 🔴 Sem `trim()` nem `toLowerCase()`, de propósito. A base guarda `'ativo'`
 *    exacto e o `CHECK` não admite outra coisa; normalizar aqui faria
 *    `' ATIVO '` entrar na aplicação e ser recusado pela 102 na base — duas
 *    respostas diferentes à mesma pergunta. O ensaio fixa isso.
 */
export function perfilPodeEntrar(status: string | null | undefined): boolean {
  return status === ESTADO_ATIVO;
}

/**
 * O que se diz a quem bate à porta depois de ter saído.
 *
 * Sem detalhe operacional: não diz se foi despedimento, suspensão ou engano,
 * porque o ecrã de login é público e a diferença não é dele.
 */
export const MENSAGEM_SEM_ACESSO =
  "O teu acesso foi desativado. Fala com a gestão se achas que é engano.";
