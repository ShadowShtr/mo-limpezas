// ============================================================================
// Ponte entre o botão «!» do cabeçalho e o modal de avisos
// ============================================================================
//
// O modal vive no layout do dashboard; o botão vive no cabeçalho de cada
// página. Não partilham pai que valha a pena transformar em contexto, por isso
// falam por este store mínimo: o modal regista-se como «abridor» e publica a
// contagem; o botão chama o abridor no próprio clique.
//
// 🔴 Só estado de UI. Nada aqui lê nem escreve na base.
// ============================================================================

import { useSyncExternalStore } from "react";

export interface EstadoAvisos {
  /** Quantos avisos o modal conhece; `null` enquanto não há modal montado. */
  total: number | null;
  /** Quantos são atrasados ou de hoje — os que pedem o número vermelho. */
  urgentes: number;
}

const INICIAL: EstadoAvisos = { total: null, urgentes: 0 };

let estado: EstadoAvisos = INICIAL;
const ouvintes = new Set<() => void>();
let abridor: (() => void) | null = null;

function publicar(novo: EstadoAvisos) {
  estado = novo;
  for (const f of ouvintes) f();
}

/** O modal regista aqui como se abre. Devolve a função que o desregista. */
export function registarAbridorAvisos(fn: () => void): () => void {
  abridor = fn;
  return () => {
    if (abridor === fn) abridor = null;
    publicar(INICIAL);
  };
}

export function pedirAbrirAvisos(): void {
  abridor?.();
}

export function definirContagemAvisos(total: number, urgentes: number): void {
  if (estado.total === total && estado.urgentes === urgentes) return;
  publicar({ total, urgentes });
}

function subscrever(f: () => void) {
  ouvintes.add(f);
  return () => { ouvintes.delete(f); };
}

export function useEstadoAvisos(): EstadoAvisos {
  return useSyncExternalStore(subscrever, () => estado, () => INICIAL);
}
