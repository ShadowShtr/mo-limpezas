import {
  URGENCIA_ORDEM,
  type AvisoItem,
  type AvisoSource,
  type AvisoUrgencia,
} from "./types";

// ============================================================================
// A CLASSIFICAÇÃO
// ============================================================================
//
// 🔴 As datas comparam-se como TEXTO, e isso é uma decisão, não uma preguiça.
//
//    Uma data civil `YYYY-MM-DD` ordena lexicograficamente na mesma ordem em
//    que ordena cronologicamente. Converter para `Date` para comparar traria o
//    fuso horário para dentro de uma decisão que não tem hora nenhuma: em
//    Lisboa, no verão, `new Date("2026-09-01")` é 31 de Agosto às 23h00 UTC, e
//    um pagamento que vence no dia 1 apareceria como atrasado no dia 31.
//
//    O projecto já pagou por esta classe de erro noutro sítio — ver o comentário
//    de `payment-competence.ts` sobre `new Date(...)`.
//
// 🔴 `today` e `tomorrow` são PARÂMETROS, não são lidos do relógio aqui.
//
//    É o que permite ensaiar a meia-noite, a mudança de mês e a mudança de hora
//    sem mexer no relógio da máquina, e é o que garante que o cron e o modal
//    classificam contra o mesmo dia mesmo que corram com segundos de diferença.

/**
 * A que grupo pertence uma data.
 *
 * `null` quer dizer «não entra» — e é devolvido para o futuro para além de
 * amanhã. Não é erro: é a janela a fazer o seu trabalho. Um aviso que mostrasse
 * tudo o que aí vem deixaria de ser um aviso e passava a ser uma agenda.
 */
export function classificar(
  date: string,
  today: string,
  tomorrow: string,
): AvisoUrgencia | null {
  if (date < today) return "atrasado";
  if (date === today) return "hoje";
  if (date === tomorrow) return "amanha";
  return null;
}

const PESO_URGENCIA: Record<AvisoUrgencia, number> =
  Object.fromEntries(URGENCIA_ORDEM.map((u, i) => [u, i])) as Record<AvisoUrgencia, number>;

// A ordem entre fontes no mesmo dia. Dinheiro primeiro: é o único destes quatro
// que tem consequência externa — juros, corte de serviço, um fornecedor à
// espera. Os outros três são compromissos internos.
const PESO_SOURCE: Record<AvisoSource, number> = {
  pagamento: 0,
  tarefa: 1,
  visita: 2,
  lead: 3,
};

/**
 * Ordem previsível e total.
 *
 * 🔴 O desempate vai até à `key`, que é única. Sem isso, duas linhas do mesmo
 *    dia e da mesma fonte podiam trocar de lugar entre renderizações e a lista
 *    mexia-se debaixo dos olhos de quem a lê. `Array.sort` é estável desde o
 *    ES2019, mas a estabilidade só preserva a ordem de ENTRADA — e a ordem de
 *    entrada aqui vem de quatro consultas que correm em paralelo.
 */
export function ordenarAvisos(itens: readonly AvisoItem[]): AvisoItem[] {
  return [...itens].sort((a, b) =>
    PESO_URGENCIA[a.urgencia] - PESO_URGENCIA[b.urgencia]
    || a.date.localeCompare(b.date)
    || PESO_SOURCE[a.source] - PESO_SOURCE[b.source]
    || a.title.localeCompare(b.title, "pt-PT")
    || a.key.localeCompare(b.key),
  );
}

/**
 * Os três grupos, já ordenados, para o modal desenhar sem decidir nada.
 *
 * Grupos vazios são devolvidos na mesma: quem desenha é que decide se esconde o
 * cabeçalho, e assim não há duas ideias diferentes sobre «está vazio».
 */
export function agruparPorUrgencia(
  itens: readonly AvisoItem[],
): Record<AvisoUrgencia, AvisoItem[]> {
  const ordenados = ordenarAvisos(itens);
  return {
    atrasado: ordenados.filter((i) => i.urgencia === "atrasado"),
    hoje: ordenados.filter((i) => i.urgencia === "hoje"),
    amanha: ordenados.filter((i) => i.urgencia === "amanha"),
  };
}

/** `{source}:{itemId}` — ver a nota em `AvisoItem.key`. */
export function avisoKey(source: AvisoSource, itemId: string): string {
  return `${source}:${itemId}`;
}
