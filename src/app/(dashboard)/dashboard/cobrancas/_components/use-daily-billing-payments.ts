"use client";

import { useCallback, useRef, useState } from "react";
import {
  setServicePayment,
  type DailyBillingData,
  type DailyBillingRow,
} from "@/app/actions/daily-billing";

type PaymentStatus = "nao_informado" | "sinal_50" | "pago_total";
type DataUpdater = (updater: (current: DailyBillingData | null) => DailyBillingData | null) => void;

interface Options {
  date: string;
  updateData: DataUpdater;
  refresh: (date?: string) => Promise<void>;
  isCurrentDate: (date: string) => boolean;
  reportError: (error: string | null) => void;
}

interface EditorSession {
  id: number;
  rowId: string;
}

export function useDailyBillingPayments({ date, updateData, refresh, isCurrentDate, reportError }: Options) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const editorRef = useRef<EditorSession | null>(null);
  const nextEditorIdRef = useRef(0);
  const nextOperationIdRef = useRef(0);
  const latestOperationRef = useRef(0);
  const pendingByRowRef = useRef(new Map<string, number>());
  const startEdit = useCallback((row: DailyBillingRow) => {
    const session = { id: ++nextEditorIdRef.current, rowId: row.id };
    editorRef.current = session;
    setEditingId(row.id);
    setAmountInput(row.paid_amount != null ? String(row.paid_amount) : "");
  }, []);

  const cancelEdit = useCallback(() => {
    editorRef.current = null;
    setEditingId(null);
  }, []);

  const applyPayment = useCallback(async (
    row: DailyBillingRow,
    status: PaymentStatus,
    amount?: number | null,
  ) => {
    const operationId = ++nextOperationIdRef.current;
    latestOperationRef.current = operationId;
    const operationDate = date;
    const editorSession = editorRef.current?.rowId === row.id ? editorRef.current : null;
    pendingByRowRef.current.set(row.id, operationId);
    setSavingIds((current) => new Set(current).add(row.id));

    try {
      const result = await setServicePayment(row.id, status, amount);
      if (!result.ok) {
        if (operationId === latestOperationRef.current && isCurrentDate(operationDate)) {
          reportError(result.error);
        }
        return;
      }

      if (!isCurrentDate(operationDate)) return;

      if (operationId === latestOperationRef.current) reportError(null);
      updateData((current) => {
        if (!current) return current;
        const patch = (item: DailyBillingRow): DailyBillingRow => item.id === row.id
          ? {
              ...item,
              payment_status: status,
              paid_amount: amount ?? null,
              paid_at: new Date().toISOString(),
            }
          : item;
        return { ...current, day: current.day.map(patch), pending: current.pending.map(patch) };
      });

      if (editorSession && editorRef.current?.id === editorSession.id) {
        editorRef.current = null;
        setEditingId(null);
      }
      void refresh(operationDate);
    } catch (cause) {
      if (operationId === latestOperationRef.current && isCurrentDate(operationDate)) {
        reportError(cause instanceof Error ? cause.message : "Erro ao registar pagamento.");
      }
    } finally {
      if (pendingByRowRef.current.get(row.id) === operationId) {
        pendingByRowRef.current.delete(row.id);
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(row.id);
          return next;
        });
      }
    }
  }, [date, isCurrentDate, refresh, reportError, updateData]);

  return {
    editingId,
    amountInput,
    savingIds,
    setAmountInput,
    startEdit,
    cancelEdit,
    applyPayment,
  };
}
