"use client";

// ============================================================================
// Leitura do Diário — só a resposta mais recente escreve estado
// ============================================================================
//
// Três fontes pedem recarga ao mesmo tempo: a navegação de dia, o Realtime e o
// fim de cada gravação. Cada pedido leva um número de geração; uma resposta só
// é aplicada se for da geração mais recente E do dia que está no ecrã.
//
//   · dia antigo não sobrescreve dia novo — muda-se de 12 para 13, a resposta
//     do 12 chega depois e é deitada fora;
//   · recarga antiga não sobrescreve recarga nova do mesmo dia — duas recargas
//     que terminam fora de ordem deixam a mais recente;
//   · mudar de dia limpa as linhas: as do dia anterior nunca ficam no ecrã como
//     se fossem acionáveis no dia novo.
//
// As gravações NÃO escrevem no estado. Terminada uma gravação, pede-se uma
// recarga — e é o snapshot do servidor, por esta mesma porta, que decide o
// que se vê. Uma resposta de gravação antiga não tem caminho para escrever por
// cima de um estado mais novo, porque não tem caminho para escrever de todo.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { getDailyBilling, type DailyBillingData } from "@/app/actions/daily-billing";

export function useDailyBillingQuery(
  initialDate: string,
  initialData: DailyBillingData | null,
  initialError: string | null,
) {
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DailyBillingData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const dateRef = useRef(initialDate);
  const generationRef = useRef(0);

  const refresh = useCallback(async (requestedDate?: string) => {
    const target = requestedDate ?? dateRef.current;
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current && target === dateRef.current;
    setLoading(true);

    try {
      const result = await getDailyBilling(target);
      if (!isCurrent()) return;
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      if (!isCurrent()) return;
      setError("Erro ao carregar cobrança diária.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  const changeDay = useCallback((newDate: string) => {
    if (newDate === dateRef.current) return;
    dateRef.current = newDate;
    setDate(newDate);
    setData(null);
    setError(null);
    void refresh(newDate);
  }, [refresh]);

  const isCurrentDate = useCallback((candidate: string) => dateRef.current === candidate, []);

  return { date, data, error, loading, refresh, changeDay, isCurrentDate };
}
