"use client";

// ============================================================================
// Gravações do Diário — uma de cada vez por linha, e o servidor decide o fim
// ============================================================================
//
// 🔴 Uma linha com gravação em curso não aceita outra. Duas gravações seguidas
//    sobre a mesma linha (50% e logo 100%) chegariam à base por ordem incerta;
//    a interface fecha essa porta antes de a abrir.
//
// 🔴 A resposta de uma gravação não escreve estado. Confirmada, pede uma
//    recarga do dia em que foi feita — e só essa recarga, se ainda for a mais
//    recente e o dia ainda for o do ecrã, mexe no que se vê. Uma gravação
//    antiga não sobrescreve um estado mais novo porque não tem por onde.
//
// Erros: só o da gravação mais recente, e só se o dia ainda for o mesmo. Uma
// falha antiga não tapa uma mensagem mais nova nem aparece noutro dia.
// ============================================================================

import { useCallback, useRef, useState } from "react";

type MutationResult = { ok: true } | { ok: false; error: string };

interface Options {
  date: string;
  refresh: (date?: string) => Promise<void>;
  isCurrentDate: (date: string) => boolean;
}

export function useBillingMutations({ date, refresh, isCurrentDate }: Options) {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [mutationError, setMutationError] = useState<string | null>(null);
  const busyRef = useRef(new Set<string>());
  const nextOpRef = useRef(0);
  const latestOpRef = useRef(0);

  const run = useCallback(async (
    rowKey: string,
    operation: () => Promise<MutationResult>,
  ): Promise<MutationResult> => {
    if (busyRef.current.has(rowKey)) {
      return { ok: false, error: "Já há uma gravação em curso nesta linha." };
    }
    const opId = ++nextOpRef.current;
    latestOpRef.current = opId;
    const opDate = date;
    busyRef.current.add(rowKey);
    setBusyKeys(new Set(busyRef.current));

    let result: MutationResult;
    try {
      result = await operation();
    } catch {
      result = { ok: false, error: "Não foi possível concluir a operação. Tente de novo." };
    }

    busyRef.current.delete(rowKey);
    setBusyKeys(new Set(busyRef.current));

    const podeFalar = opId === latestOpRef.current && isCurrentDate(opDate);
    if (!result.ok) {
      if (podeFalar) setMutationError(result.error);
      return result;
    }
    if (podeFalar) setMutationError(null);
    // Confirmada pela base: o ecrã converge pelo snapshot, não pela resposta.
    // Recarrega o dia que ESTÁ no ecrã — mesmo que já não seja o da gravação,
    // a linha pode aparecer nos pendentes dele.
    void refresh();
    return result;
  }, [date, isCurrentDate, refresh]);

  const isBusy = useCallback((rowKey: string) => busyKeys.has(rowKey), [busyKeys]);

  return { run, isBusy, busyKeys, mutationError, clearMutationError: () => setMutationError(null) };
}
