// TASK 03 — Fila de upload offline de fotos com IndexedDB.
// Guarda o blob comprimido + metadata para que nenhuma foto se perca quando
// a internet cai. localStorage não serve (síncrono, pequeno, mau para blobs).

const DB_NAME = "mo-limpezas-uploads";
const DB_VERSION = 1;
const STORE = "photo-queue";

// Política de retenção (TASK 03): falhados ficam X dias, fila não cresce infinita.
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_ITEMS = 200;

export type QueueStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed"
  | "needs_user_action";

export interface QueuedUpload {
  client_event_id: string; // chave primária (idempotência)
  service_id: string;
  kind: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  originalSize: number;
  compressedSize: number;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  lastRetryAt: number | null;
  status: QueueStatus;
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "client_event_id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb-open-failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const request = fn(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

function getAllRaw(): Promise<QueuedUpload[]> {
  return tx<QueuedUpload[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedUpload[]>);
}

/** Adiciona (ou substitui) um upload na fila. Idempotente por client_event_id. */
export async function enqueueUpload(
  item: Omit<QueuedUpload, "attempts" | "lastError" | "createdAt" | "lastRetryAt" | "status"> &
    Partial<Pick<QueuedUpload, "status">>,
): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  await pruneQueue();
  const record: QueuedUpload = {
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
    lastRetryAt: null,
    status: item.status ?? "queued",
    ...item,
  };
  try {
    await tx("readwrite", (s) => s.put(record));
    return true;
  } catch {
    return false;
  }
}

export async function getAllUploads(): Promise<QueuedUpload[]> {
  if (!hasIndexedDB()) return [];
  try {
    return await getAllRaw();
  } catch {
    return [];
  }
}

export async function getPendingUploads(): Promise<QueuedUpload[]> {
  const all = await getAllUploads();
  return all.filter((u) => u.status === "queued" || u.status === "failed");
}

export async function countPending(): Promise<number> {
  return (await getPendingUploads()).length;
}

export async function getUpload(clientEventId: string): Promise<QueuedUpload | null> {
  if (!hasIndexedDB()) return null;
  try {
    const r = await tx<QueuedUpload | undefined>("readonly", (s) => s.get(clientEventId) as IDBRequest<QueuedUpload | undefined>);
    return r ?? null;
  } catch {
    return null;
  }
}

export async function updateUpload(
  clientEventId: string,
  patch: Partial<QueuedUpload>,
): Promise<void> {
  const current = await getUpload(clientEventId);
  if (!current) return;
  try {
    await tx("readwrite", (s) => s.put({ ...current, ...patch }));
  } catch { /* ignore */ }
}

export async function markUploading(clientEventId: string): Promise<void> {
  await updateUpload(clientEventId, { status: "uploading", lastRetryAt: Date.now() });
}

export async function markUploaded(clientEventId: string): Promise<void> {
  // Removido após confirmação — não precisamos manter o blob.
  await removeUpload(clientEventId);
}

export async function markFailed(clientEventId: string, error: string): Promise<void> {
  const current = await getUpload(clientEventId);
  if (!current) return;
  const attempts = current.attempts + 1;
  await updateUpload(clientEventId, {
    status: "failed",
    attempts,
    lastError: error,
    lastRetryAt: Date.now(),
  });
}

export async function markNeedsUserAction(clientEventId: string, error: string): Promise<void> {
  await updateUpload(clientEventId, { status: "needs_user_action", lastError: error });
}

export async function removeUpload(clientEventId: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    await tx("readwrite", (s) => s.delete(clientEventId));
  } catch { /* ignore */ }
}

/**
 * Limpeza: remove falhados antigos e impede crescimento infinito da fila.
 * Mantém os mais recentes até MAX_QUEUE_ITEMS.
 */
export async function pruneQueue(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const all = await getAllRaw();
    const now = Date.now();
    const expired = all.filter(
      (u) => u.status === "failed" && now - u.createdAt > FAILED_RETENTION_MS,
    );
    for (const u of expired) await removeUpload(u.client_event_id);

    const remaining = all
      .filter((u) => !expired.includes(u))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (remaining.length > MAX_QUEUE_ITEMS) {
      for (const u of remaining.slice(MAX_QUEUE_ITEMS)) await removeUpload(u.client_event_id);
    }
  } catch { /* ignore */ }
}
