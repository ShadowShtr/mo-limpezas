// ============================================================================
// Falhas de consulta — T17-B3
// ============================================================================
//
// O padrão que este módulo existe para corrigir:
//
//     const { data } = await admin.from("x").select(...)
//     if (!data) return { ok: false, error: "Não encontrado." }
//
// O `error` não é desestruturado. Quando a consulta falha, `data` vem `null` e
// o código a seguir conclui **"não existe"** — que é uma afirmação sobre o
// mundo, feita a partir de uma falha técnica. A diferença entre "não há
// registos" e "não consegui perguntar" desaparece antes de chegar a quem
// decide.
//
// A T17-A contou 268 pontos destes. A T17-B1 mediu-lhes o dano. Esta é a
// ferramenta com que a T17-B3 os fecha.
//
// ---------------------------------------------------------------------------
// Duas leituras, dois tratamentos
// ---------------------------------------------------------------------------
//
// **Prerequisite** — a leitura decide *se* ou *o quê* escrever: existe? há
// duplicado? qual a relação? quem é o dono? Aqui uma falha tem de **abortar a
// mutação**. Nunca virar "não existe", "sem conflito" ou "lista vazia", porque
// cada uma dessas leituras erradas autoriza uma escrita que não devia
// acontecer. Usar `queryFailure()`.
//
// **Auxiliary** — a leitura enriquece uma resposta já decidida: o nome para
// mostrar, o caminho a revalidar. Aqui abortar seria pior do que o problema,
// e o contrato destas actions não tem um estado "parcial" onde encaixar a
// falha. Usar `logQueryFailure()`: o caminho de sucesso fica **exactamente**
// como estava, e a falha deixa de ser invisível.
//
// A escolha entre os dois **não é de estilo**. É a pergunta "se esta leitura
// mentir, alguma escrita acontece que não devia?".
//
// ---------------------------------------------------------------------------
// O que nunca sai daqui para o ecrã
// ---------------------------------------------------------------------------
// `error.message` do PostgREST traz nomes de tabelas, colunas, restrições e
// políticas RLS. Não ajuda quem está a usar a aplicação e conta a quem não
// devia como a base está construída. O detalhe vai para o log do servidor; o
// utilizador recebe uma frase estável.
// ============================================================================

/**
 * Mensagem única para uma leitura que falhou.
 *
 * Deliberadamente distinta de "não encontrado": é essa confusão que o módulo
 * inteiro existe para desfazer. Quem a lê sabe que o problema foi técnico e
 * que tentar outra vez faz sentido — o que não é verdade de um "não existe".
 */
export const QUERY_FAILURE_MESSAGE =
  "Não foi possível confirmar os dados necessários. Tenta novamente.";

/** A forma mínima de um erro do Supabase, sem depender do tipo do SDK. */
export interface QueryErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * O PostgREST devolve `PGRST116` quando `.single()` não encontra exactamente
 * uma linha.
 *
 * Isto **não é uma falha**: é a resposta correcta a "este registo existe?".
 * Tratá-lo como erro técnico transformaria todo o `if (!data) return "não
 * encontrado"` numa mensagem de avaria — o erro simétrico ao que esta task
 * corrige, e igualmente errado.
 *
 * Com `.maybeSingle()` o caso não se põe (devolve `data: null` sem erro); a
 * função existe para os muitos `.single()` já espalhados pelo código.
 */
export function isNoRowsError(error: QueryErrorLike | null | undefined): boolean {
  return error?.code === "PGRST116";
}

/**
 * Regista a falha no log do servidor, com um prefixo greppável.
 *
 * Só `code` e `message` — `details` e `hint` do PostgREST podem incluir valores
 * das próprias linhas, e um log não é sítio para dados de clientes.
 *
 * Usar sozinho apenas em leituras **auxiliares**. Numa leitura de que dependa
 * uma escrita, registar sem abortar é trocar uma falha silenciosa por uma falha
 * documentada — e a escrita errada acontece na mesma.
 */
export function logQueryFailure(
  contexto: string,
  error: QueryErrorLike | null | undefined,
): void {
  if (!error) return;
  console.error(
    `[query:${contexto}] leitura falhou`,
    { code: error.code ?? null, message: error.message ?? null },
  );
}

/**
 * Regista a falha e devolve o resultado de recusa na forma antiga
 * (`{ ok: false, error: string }`), que é a que a maioria destas actions ainda
 * usa.
 *
 * Não migra ninguém para `ActionResult`: essa é a T05/T06, e misturá-la com
 * tratamento de erro tornaria impossível ver, no diff, o que mudou de
 * comportamento. Onde a action já usa `ActionResult`, usar `internalFailure`
 * de `action-result.ts` em vez desta.
 */
export function queryFailure(
  contexto: string,
  error: QueryErrorLike | null | undefined,
): { ok: false; error: string } {
  logQueryFailure(contexto, error);
  return { ok: false, error: QUERY_FAILURE_MESSAGE };
}
