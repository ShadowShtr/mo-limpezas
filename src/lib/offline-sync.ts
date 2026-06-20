// Fila offline para registos de ponto (clock-in/out) quando não há rede.
// Usa IndexedDB como armazenamento primário (mais fiável que localStorage:
// disponível em iOS Safari private mode, sem limite de 5MB, assíncrono).
// Mantém API assíncrona compatível com o código existente.

import {
  queueTimesheet as idbQueue,
  getPendingTimesheets,
  getFailedTimesheets,
  removePending,
  addFailed,
  clearFailed as idbClearFailed,
  type PendingTimesheet,
  type FailedTimesheet,
} from "@/lib/offline/timesheet-queue";

export type { PendingTimesheet, FailedTimesheet };

const MAX_AGE_HOURS = 24;

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Guarda o registo de ponto na fila IndexedDB.
 * Lança erro se a persistência falhar — o chamador deve mostrar aviso real
 * em vez de "guardado offline" quando IndexedDB não estiver disponível.
 */
export async function queueTimesheet(
  entry: Omit<PendingTimesheet, "id" | "created_offline_at">,
): Promise<PendingTimesheet> {
  const item: PendingTimesheet = {
    ...entry,
    id: `${entry.service_id}-${entry.kind}-${Date.now()}`,
    created_offline_at: new Date().toISOString(),
  };
  await idbQueue(entry); // propaga erro se IndexedDB falhar
  return item;
}

export function pendingCount(): number {
  // Sincronizar a contagem assincronamente não é possível sem await.
  // O componente deve usar initOfflineSync(onChange) para reagir às mudanças.
  return 0;
}

export function failedCount(): number {
  return 0;
}

export async function readFailed(): Promise<FailedTimesheet[]> {
  try {
    return await getFailedTimesheets();
  } catch {
    return [];
  }
}

export async function clearFailed(): Promise<void> {
  try {
    await idbClearFailed();
  } catch { /* ignore */ }
}

// ─── Sincronização ───────────────────────────────────────────────────────────

export async function syncPendingTimesheets(): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;

  let list: PendingTimesheet[];
  try {
    list = await getPendingTimesheets();
  } catch {
    return 0;
  }

  if (list.length === 0) return 0;

  const nowMs = Date.now();
  let synced = 0;

  for (const item of list) {
    // Verificar idade máxima
    if (item.created_offline_at) {
      const ageHours = (nowMs - new Date(item.created_offline_at).getTime()) / 3_600_000;
      if (ageHours > MAX_AGE_HOURS) {
        await addFailed({
          ...item,
          fail_reason: `Ponto offline guardado há mais de ${MAX_AGE_HOURS}h sem rede`,
          failed_at: new Date().toISOString(),
        });
        await removePending(item.client_event_id);
        synced++;
        continue;
      }
    }

    try {
      const res = await fetch("/api/app/timesheet", {
        method: item.kind === "in" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: item.service_id,
          lat: item.lat,
          lng: item.lng,
          [item.kind === "in" ? "clock_in_at" : "clock_out_at"]: item.at,
          manual: item.manual ?? false,
          gps_accuracy: item.gps_accuracy ?? null,
          client_event_id: item.client_event_id,
        }),
      });

      if (res.ok || res.status === 409) {
        await removePending(item.client_event_id);
        synced++;
      } else if (res.status >= 500 || res.status === 503) {
        // Erro do servidor → manter para nova tentativa
      } else if (res.status === 401 || res.status === 403) {
        // Sessão expirada → manter; vai resolver ao fazer login
      } else if (res.status === 404) {
        await addFailed({
          ...item,
          fail_reason: "Serviço não encontrado (apagado ou sem permissão)",
          failed_at: new Date().toISOString(),
        });
        await removePending(item.client_event_id);
        synced++;
      } else {
        let reason = `Erro ${res.status}`;
        try { const j = await res.json(); reason = j.error ?? reason; } catch { /* ignorar */ }
        await addFailed({ ...item, fail_reason: reason, failed_at: new Date().toISOString() });
        await removePending(item.client_event_id);
        synced++;
      }
    } catch {
      // Sem rede → manter na fila
    }
  }

  if (typeof window !== "undefined") {
    const remaining = await getPendingTimesheets().catch(() => []);
    const failed = await getFailedTimesheets().catch(() => []);
    window.dispatchEvent(new CustomEvent("pending-timesheets-changed", {
      detail: { pending: remaining.length, failed: failed.length },
    }));
  }

  return synced;
}

export function initOfflineSync(
  onChange?: (pending: number, failed: number) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handleOnline = () => { void syncPendingTimesheets(); };

  const handleChange = async () => {
    if (!onChange) return;
    const [pending, failed] = await Promise.all([
      getPendingTimesheets().then((l) => l.length).catch(() => 0),
      getFailedTimesheets().then((l) => l.length).catch(() => 0),
    ]);
    onChange(pending, failed);
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("pending-timesheets-changed", () => void handleChange());

  void syncPendingTimesheets();
  void handleChange();

  return () => {
    window.removeEventListener("online", handleOnline);
  };
}
