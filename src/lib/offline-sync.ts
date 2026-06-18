// Fila offline para registos de ponto (clock-in/out) quando não há rede.
// Guardada em localStorage com fallback em memória; sincroniza quando a ligação volta.

const KEY = "pending-timesheets";
const FAILED_KEY = "failed-timesheets"; // itens que precisam de revisão do gestor
const MAX_AGE_HOURS = 24; // pontos offline com mais de 24h ficam em revisão

export interface PendingTimesheet {
  id: string;             // id local único (usado internamente na fila)
  client_event_id: string; // UUID idempotência — enviado ao servidor
  kind: "in" | "out";
  service_id: string;
  lat: number | null;
  lng: number | null;
  at: string;             // ISO — hora real do toque
  manual?: boolean;       // clock-in sem GPS confirmado pela colaboradora
  gps_accuracy?: number | null; // metros, null se manual
  created_offline_at?: string;  // quando foi guardado na fila
}

export interface FailedTimesheet extends PendingTimesheet {
  fail_reason: string;
  failed_at: string;
}

// Fallback em memória quando localStorage está cheio/bloqueado
let memQueue: PendingTimesheet[] = [];
let memFailed: FailedTimesheet[] = [];

// ─── Helpers de leitura/escrita ──────────────────────────────────────────────

function readLS<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as T[];
  } catch {
    return [];
  }
}

function writeLS<T>(key: string, list: T[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (e) {
    console.warn(`[offline-sync] localStorage write failed (${key}):`, e);
    return false;
  }
}

function read(): PendingTimesheet[] {
  const ls = readLS<PendingTimesheet>(KEY);
  // Deduplicar: preferir localStorage; memQueue só tem itens que não foram guardados
  const lsIds = new Set(ls.map((i) => i.id));
  const extras = memQueue.filter((i) => !lsIds.has(i.id));
  return [...ls, ...extras];
}

function write(list: PendingTimesheet[]) {
  if (typeof window === "undefined") return;
  const ok = writeLS(KEY, list);
  if (!ok) {
    // localStorage falhou — manter em memória para esta sessão
    memQueue = list;
    if (list.length > 0) {
      console.warn("[offline-sync] Pontos em memória apenas — recarregue a app para tentar guardar.");
    }
  } else {
    // Remover da memQueue itens que já estão no localStorage
    const savedIds = new Set(list.map((i) => i.id));
    memQueue = memQueue.filter((i) => !savedIds.has(i.id));
  }
  window.dispatchEvent(new CustomEvent("pending-timesheets-changed", { detail: read().length }));
}

function writeFailed(list: FailedTimesheet[]) {
  const ok = writeLS(FAILED_KEY, list);
  if (!ok) memFailed = list;
  else memFailed = memFailed.filter((i) => !list.find((j) => j.id === i.id));
}

// ─── API pública ─────────────────────────────────────────────────────────────

export function queueTimesheet(entry: Omit<PendingTimesheet, "id" | "created_offline_at">): PendingTimesheet {
  const item: PendingTimesheet = {
    ...entry,
    id: `${entry.service_id}-${entry.kind}-${Date.now()}`,
    created_offline_at: new Date().toISOString(),
  };
  write([...read(), item]);
  return item;
}

export function pendingCount(): number {
  return read().length;
}

export function failedCount(): number {
  const ls = readLS<FailedTimesheet>(FAILED_KEY);
  const lsIds = new Set(ls.map((i) => i.id));
  return ls.length + memFailed.filter((i) => !lsIds.has(i.id)).length;
}

export function readFailed(): FailedTimesheet[] {
  const ls = readLS<FailedTimesheet>(FAILED_KEY);
  const lsIds = new Set(ls.map((i) => i.id));
  return [...ls, ...memFailed.filter((i) => !lsIds.has(i.id))];
}

export function clearFailed() {
  writeLS(FAILED_KEY, []);
  memFailed = [];
}

// ─── Sincronização ───────────────────────────────────────────────────────────

/** Tenta enviar todos os registos em fila. Devolve quantos sincronizaram. */
export async function syncPendingTimesheets(): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;

  const list = read();
  if (list.length === 0) return 0;

  const remaining: PendingTimesheet[] = [];
  const failed: FailedTimesheet[] = [...readLS<FailedTimesheet>(FAILED_KEY)];
  let synced = 0;
  const nowMs = Date.now();

  for (const item of list) {
    // Verificar idade máxima: se offline há mais de MAX_AGE_HOURS, mover para revisão
    if (item.created_offline_at) {
      const ageHours = (nowMs - new Date(item.created_offline_at).getTime()) / 3_600_000;
      if (ageHours > MAX_AGE_HOURS) {
        failed.push({ ...item, fail_reason: `Ponto offline guardado há mais de ${MAX_AGE_HOURS}h sem rede`, failed_at: new Date().toISOString() });
        synced++; // remover da fila activa
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
        // Sucesso ou duplicado já existente → resolvido
        synced++;
      } else if (res.status >= 500 || res.status === 503) {
        // Erro do servidor → manter para nova tentativa
        remaining.push(item);
      } else if (res.status === 401 || res.status === 403) {
        // Sessão expirada ou sem permissão → manter; vai resolver ao fazer login
        remaining.push(item);
      } else if (res.status === 404) {
        // Serviço apagado/não encontrado → mover para revisão, não descartar silenciosamente
        failed.push({ ...item, fail_reason: "Serviço não encontrado (apagado ou sem permissão)", failed_at: new Date().toISOString() });
        synced++;
      } else {
        // Outro 4xx (janela horária, etc.) → mover para revisão
        let reason = `Erro ${res.status}`;
        try { const j = await res.json(); reason = j.error ?? reason; } catch { /* ignorar */ }
        failed.push({ ...item, fail_reason: reason, failed_at: new Date().toISOString() });
        synced++;
      }
    } catch {
      remaining.push(item); // sem rede → manter
    }
  }

  write(remaining);
  if (failed.length > 0) writeFailed(failed);

  return synced;
}

/** Regista listeners para sincronizar automaticamente. Devolve cleanup. */
export function initOfflineSync(onChange?: (pending: number, failed: number) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleOnline = () => { void syncPendingTimesheets(); };
  const handleChange = () => { onChange?.(pendingCount(), failedCount()); };

  window.addEventListener("online", handleOnline);
  window.addEventListener("pending-timesheets-changed", handleChange);

  void syncPendingTimesheets();
  handleChange();

  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("pending-timesheets-changed", handleChange);
  };
}
