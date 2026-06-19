import { useRef, useCallback } from "react";

// TASK 24 — Proteção contra cliques repetidos no frontend.
// Garante que uma ação assíncrona não corre duas vezes em simultâneo, mesmo que
// o utilizador toque várias vezes antes do React atualizar o estado de loading
// (o `disabled` por estado tem uma micro-janela; um ref é síncrono e fecha-a).
//
// Opcionalmente impõe um "cooldown" mínimo entre execuções (ms).
export function useSingleFlight(cooldownMs = 0) {
  const inFlight = useRef(false);
  const lastRun = useRef(0);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      if (inFlight.current) return undefined;
      if (cooldownMs > 0 && Date.now() - lastRun.current < cooldownMs) return undefined;

      inFlight.current = true;
      try {
        return await action();
      } finally {
        inFlight.current = false;
        lastRun.current = Date.now();
      }
    },
    [cooldownMs],
  );

  return run;
}
