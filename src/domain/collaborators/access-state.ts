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
// Porque é que `null` deixa entrar
// ----------------------------------------------------------------------------
//
// `profiles.status` é anulável e só ganhou `DEFAULT 'ativo'` em 002. Uma linha
// com `status` a NULL é uma pessoa normal cujo estado ninguém escreveu — não
// é uma pessoa que levou saída.
//
// Fechar na ausência seria o instinto («fail-closed»), e aqui seria o erro:
// trancava fora toda a gente cujo estado nunca foi tocado, num sistema em uso
// real, por causa de uma coluna anulável. O que se fecha é a saída EXPLÍCITA
// — alguém escreveu «inativo», «suspenso» ou «arquivado» naquela linha. É uma
// lista de quem NÃO entra, e é curta de propósito: um estado novo que ninguém
// mapeie aqui deixa entrar, em vez de trancar meia empresa em silêncio.
//
// A contrapartida é o ensaio `access-state.test.ts`, que obriga esta lista a
// conter todos os estados de saída que o sistema sabe escrever.
// ============================================================================

/**
 * Os estados que significam «esta pessoa já não trabalha aqui».
 *
 * `arquivado` está aqui apesar de o `CHECK` da base ainda não o aceitar: o
 * Zod de `colaboradores.ts` declara-o, e um estado que a aplicação sabe
 * escrever tem de ser um estado que a aplicação sabe recusar. O dia em que os
 * dois lados forem alinhados, esta lista já está certa.
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
 */
export function perfilPodeEntrar(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  const normalizado = status.trim().toLowerCase();
  if (normalizado === "") return true;
  return !(ESTADOS_SEM_ACESSO as readonly string[]).includes(normalizado);
}

/**
 * O que se diz a quem bate à porta depois de ter saído.
 *
 * Sem detalhe operacional: não diz se foi despedimento, suspensão ou engano,
 * porque o ecrã de login é público e a diferença não é dele.
 */
export const MENSAGEM_SEM_ACESSO =
  "O teu acesso foi desativado. Fala com a gestão se achas que é engano.";
