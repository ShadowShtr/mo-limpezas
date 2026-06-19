// Fila IndexedDB para registos de ponto (clock-in/out) offline.
// Mais fiável que localStorage: disponível em iOS Safari private mode,
// não tem limite de 5MB, e é assíncrono (não bloqueia a thread principal).

const DB_NAME = "mo-limpezas-timesheets";
const DB_VERSION = 1;
const STORE = "timesheet-queue";
const FAILED_STORE = "timesheet-failed";

export interface PendingTimesheet {
  id: string;
  client_event_id: string;
  kind: "in" | "out";
  service_id: string;
  lat: number | null;
  lng: number | null;
  at: string;
  manual?: boolean;
  gps_accuracy?: number | null;
  created_offline_at?: string;
}

export interface FailedTimesheet extends PendingTimesheet {
  fail_reason: string;
  failed_at: string;
}

// ─── IndexedDB helpers ───────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "client_event_id" });
      }
      if (!db.objectStoreNames.contains(FAILED_STORE)) {
        db.createObjectStore(FAILED_STORE, { keyPath: "client_event_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txGet<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror   = () => reject(req.error);
  });
}

function txPut(db: IDBDatabase, storeName: string, item: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(item);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function txDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─── API pública ─────────────────────────────────────────────────────────────

export async function queueTimesheet(
  entry: Omit<PendingTimesheet, "id" | "created_offline_at">,
): Promise<PendingTimesheet> {
  const item: PendingTimesheet = {
    ...entry,
    id: `${entry.service_id}-${entry.kind}-${Date.now()}`,
    created_offline_at: new Date().toISOString(),
  };
  const db = await openDB();
  await txPut(db, STORE, item);
  db.close();
  dispatchChange();
  return item;
}

export async function getPendingTimesheets(): Promise<PendingTimesheet[]> {
  const db = await openDB();
  const items = await txGet<PendingTimesheet>(db, STORE);
  db.close();
  return items;
}

export async function removePending(clientEventId: string): Promise<void> {
  const db = await openDB();
  await txDelete(db, STORE, clientEventId);
  db.close();
  dispatchChange();
}

export async function getFailedTimesheets(): Promise<FailedTimesheet[]> {
  const db = await openDB();
  const items = await txGet<FailedTimesheet>(db, FAILED_STORE);
  db.close();
  return items;
}

export async function addFailed(item: FailedTimesheet): Promise<void> {
  const db = await openDB();
  await txPut(db, FAILED_STORE, item);
  db.close();
}

export async function clearFailed(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(FAILED_STORE, "readwrite");
  await new Promise<void>((resolve, reject) => {
    const req = tx.objectStore(FAILED_STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  db.close();
}

function dispatchChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pending-timesheets-changed"));
  }
}
