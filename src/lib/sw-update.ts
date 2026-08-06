// ============================================================================
// AVISO DE ATUALIZAÇÃO DO PWA — lógica pura, testável sem DOM
// ============================================================================
// Corrige um bug real de produção: o aviso "Atualizar" podia reaparecer
// repetidamente para a MESMA versão, e nada impedia mais de um reload por
// atualização. Duas causas juntas:
//
//   1. scripts/stamp-sw.mjs usava `Date.now()` para gerar a versão do
//      service worker — cada build/redeploy tinha uma versão nova mesmo sem
//      nenhum código novo, e o browser mostrava "há atualização" para algo
//      que já estava aplicado. Corrigido lá: a versão passa a ser o SHA do
//      commit (só muda quando entra código novo em produção).
//   2. mesmo com a versão certa, nada guardava "o utilizador já aceitou a
//      versão X" — depois de recarregar, se o service worker ainda
//      reportasse X como "waiting" por qualquer motivo (evento a mais,
//      timing de ativação), o aviso reaparecia para a mesma versão outra
//      vez. Corrigido aqui: `getLastAcceptedVersion`/`setLastAcceptedVersion`
//      guardam a última versão aceite em localStorage, e
//      `shouldShowUpdatePrompt` nunca mostra o aviso outra vez para ela —
//      mas continua a mostrar assim que entrar uma versão (SHA) diferente.
//
// A parte que fala com o service worker (MessageChannel, DOM, reload) fica
// em src/lib/hooks/use-service-worker-update.ts — não é testável aqui
// porque vitest.config.ts corre em ambiente "node", sem DOM. Este ficheiro
// só contém as decisões puras, para poderem ser verificadas diretamente.
// ============================================================================

export const SW_LAST_ACCEPTED_KEY = "mo-limpezas:sw-last-accepted-version";

/** Só o que este módulo precisa do Storage do browser — facilita testar com um fake. */
export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Lê a última versão aceite pelo utilizador neste navegador. Nunca lança (ex.: storage bloqueado). */
export function getLastAcceptedVersion(storage: MinimalStorage): string | null {
  try {
    return storage.getItem(SW_LAST_ACCEPTED_KEY);
  } catch {
    return null;
  }
}

/**
 * Guarda a versão aceite. Nunca lança — no pior caso (quota esgotada, modo
 * privado a bloquear escrita) o aviso pode reaparecer numa sessão futura,
 * o que é inofensivo; nunca deve rebentar o fluxo de atualização.
 */
export function setLastAcceptedVersion(storage: MinimalStorage, version: string): void {
  try {
    storage.setItem(SW_LAST_ACCEPTED_KEY, version);
  } catch {
    /* ignora */
  }
}

/**
 * Decide se o aviso de atualização deve aparecer para `waitingVersion`.
 *   - nunca aparece sem uma versão válida (ainda não determinada, ou o
 *     service worker não respondeu à pergunta de versão a tempo);
 *   - nunca aparece outra vez para a MESMA versão já aceite neste navegador,
 *     mesmo depois de recarregar ou de o evento `updatefound` disparar de
 *     novo por qualquer motivo;
 *   - aparece sempre que a versão em espera for DIFERENTE da última aceite
 *     — incluindo quando não há nenhuma versão aceite ainda (1ª atualização
 *     desde que o PWA foi instalado).
 */
export function shouldShowUpdatePrompt(
  waitingVersion: string | null | undefined,
  lastAcceptedVersion: string | null,
): boolean {
  if (!waitingVersion) return false;
  return waitingVersion !== lastAcceptedVersion;
}

/**
 * Guarda de execução única — chamada quantas vezes for (ex.: o evento
 * `controllerchange` E o fallback de 3s podem disparar os dois), só corre a
 * função uma vez. É o que impede o loop de reload: sem isto, um
 * `controllerchange` a disparar depois do fallback já ter recarregado
 * causava um SEGUNDO reload em cima do primeiro.
 */
export function createOnceGuard(): { run: (fn: () => void) => void; hasRun: () => boolean } {
  let done = false;
  return {
    run(fn) {
      if (done) return;
      done = true;
      fn();
    },
    hasRun: () => done,
  };
}
