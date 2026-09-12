"use client";

import { useCallback, useRef, useState } from "react";
import { getDailyBilling, type DailyBillingData } from "@/app/actions/daily-billing";

type DataUpdater = (current: DailyBillingData | null) => DailyBillingData | null;

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
    setLoading(true);

    try {
      const result = await getDailyBilling(target);
      if (generation !== generationRef.current || target !== dateRef.current) return;

      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch (cause) {
      if (generation !== generationRef.current || target !== dateRef.current) return;
      setError(cause instanceof Error ? cause.message : "Erro ao carregar cobrança diária.");
    } finally {
      if (generation === generationRef.current && target === dateRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const changeDay = useCallback((newDate: string) => {
    dateRef.current = newDate;
    setDate(newDate);
    setData(null);
    setError(null);
    void refresh(newDate);
  }, [refresh]);

  const updateData = useCallback((updater: DataUpdater) => {
    setData(updater);
  }, []);

  return {
    date,
    data,
    error,
    loading,
    refresh,
    changeDay,
    updateData,
    reportError: setError,
  };
}

