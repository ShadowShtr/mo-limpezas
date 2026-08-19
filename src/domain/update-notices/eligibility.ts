// ============================================================================
// AVISOS — quem recebe o quê, e quantos de cada vez
// ============================================================================
// Funções puras: recebem listas, devolvem listas. Sem base de dados, sem
// React. É aqui que vivem as regras que decidem o que aparece no ecrã, e é por
// isso que são testáveis sem montar nada.
// ============================================================================

import type { NoticeForDisplay, ReleaseNote } from "./types";

/**
 * 🔴 Corte de activação do sistema.
 *
 * A data em que esta funcionalidade entrou em produção. Notas anteriores a
 * isto não são entregues a ninguém — não porque sejam irrelevantes, mas
 * porque nunca existiu a expectativa de as receber. Sem este corte, o primeiro
 * arranque despejaria changelog histórico que ninguém pediu.
 *
 * Não se resolve marcando-as como lidas: isso gravaria um `read_at` que nunca
 * aconteceu. É regra de elegibilidade, não leitura falsa.
 */
export const UPDATE_NOTICES_SYSTEM_ACTIVATED_AT = "2026-08-19T00:00:00.000Z";

/**
 * Quantas notas de release automáticas por ciclo de apresentação.
 *
 * Alguém que fique meses sem entrar acumula notas. Mostrar «1 de 14» é uma
 * parede que se fecha sem ler. Três de cada vez, sempre as mais recentes: nada
 * se perde, nada é marcado em silêncio, e as restantes voltam no ciclo
 * seguinte.
 */
export const AUTOMATIC_RELEASE_BATCH_SIZE = 3;

/**
 * Uma nota de release é elegível quando é posterior **às duas** datas:
 *
 *   · a criação do perfil — quem entrou depois não recebe o que mudou antes;
 *   · a activação do sistema — ninguém recebe changelog anterior à sua
 *     existência.
 *
 * Equivale a `publishedAt >= max(profileCreatedAt, ACTIVATED_AT)`.
 */
export function releaseElegivel(
  nota: Pick<ReleaseNote, "publishedAt">,
  profileCreatedAt: string,
  activatedAt: string = UPDATE_NOTICES_SYSTEM_ACTIVATED_AT,
): boolean {
  const pub = Date.parse(nota.publishedAt);
  if (Number.isNaN(pub)) return false;

  const criado = Date.parse(profileCreatedAt);
  const activo = Date.parse(activatedAt);
  const corte = Math.max(Number.isNaN(criado) ? 0 : criado, Number.isNaN(activo) ? 0 : activo);

  return pub >= corte;
}

/** Mais recente primeiro; `key` desempata para a ordem ser determinística. */
function maisRecentePrimeiro(a: NoticeForDisplay, b: NoticeForDisplay): number {
  const d = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  if (d !== 0) return d;
  return a.key.localeCompare(b.key);
}

/**
 * O que se mostra neste ciclo.
 *
 * 🔴 Duas regras que não são simetria acidental:
 *
 *   1. **Os manuais vêm todos, e vêm primeiro.** Se alguém publicou um aviso
 *      para uma conta específica, quer que chegue — não que fique atrás de
 *      changelog automático nem que seja cortado por um limite.
 *
 *   2. **As automáticas vêm no máximo três, as mais recentes.** As restantes
 *      continuam por ler na fonte, sem qualquer `read_at` gravado, e voltam no
 *      ciclo seguinte.
 */
export function selecionarCiclo(
  naoLidos: NoticeForDisplay[],
  tamanhoLote: number = AUTOMATIC_RELEASE_BATCH_SIZE,
): NoticeForDisplay[] {
  const manuais = naoLidos.filter((n) => n.source === "manual").sort(maisRecentePrimeiro);
  const releases = naoLidos
    .filter((n) => n.source === "release")
    .sort(maisRecentePrimeiro)
    .slice(0, Math.max(0, tamanhoLote));

  return [...manuais, ...releases];
}

/**
 * Converte notas de código para a forma de apresentação, já filtradas por
 * elegibilidade e por leitura.
 */
export function releasesPorMostrar(
  notas: ReleaseNote[],
  profileCreatedAt: string,
  jaLidas: ReadonlySet<string>,
  activatedAt: string = UPDATE_NOTICES_SYSTEM_ACTIVATED_AT,
): NoticeForDisplay[] {
  return notas
    .filter((n) => !jaLidas.has(n.key))
    .filter((n) => releaseElegivel(n, profileCreatedAt, activatedAt))
    .map((n) => ({
      key: n.key,
      kind: n.kind,
      title: n.title,
      message: n.message,
      publishedAt: n.publishedAt,
      source: "release" as const,
    }));
}
