// Fila offline para registos de ponto (clock-in/out) quando não há rede.
// Guardada em localStorage; sincroniza quando a ligação volta.

const KEY = "pending-timesheets";

export interface PendingTimesheet {
  id: string;            // id local único
  kind: "in" | "out";    // clock-in ou clock-out
  service_id: string;
  lat: number | null;
  lng: number | null;
  at: string;            // ISO — hora real do toque
}

function read(): PendingTimesheet[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as PendingTimesheet[];
  } catch {
    return [];
  }
}

function write(list: PendingTimesheet[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    // Storage cheio (QuotaExceededError) ou bloqueado — continuar sem crash;
    // os dados ficam apenas em memória até a próxima reload.
    console.warn("[offline-sync] localStorage write failed:", e);
  }
  window.dispatchEvent(new CustomEvent("pending-timesheets-changed", { detail: list.length }));
}

export function queueTimesheet(entry: Omit<PendingTimesheet, "id">): PendingTimesheet {
  const item: PendingTimesheet = { ...entry, id: `${entry.service_id}-${entry.kind}-${Date.now()}` };
  write([...read(), item]);
  return item;
}

export function pendingCount(): number {
  return read().length;
}

/** Tenta enviar todos os registos em fila. Devolve quantos sincronizaram. */
export async function syncPendingTimesheets(): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;

  const list = read();
  if (list.length === 0) return 0;

  const remaining: PendingTimesheet[] = [];
  let synced = 0;

  for (const item of list) {
    try {
      const res = await fetch("/api/app/timesheet", {
        method: item.kind === "in" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: item.service_id,
          lat: item.lat,
          lng: item.lng,
          [item.kind === "in" ? "clock_in_at" : "clock_out_at"]: item.at,
        }),
      });
      // 2xx ou conflito de duplicado (já existe) → considerar resolvido
      if (res.ok || res.status === 409) {
        synced++;
      } else if (res.status >= 500 || res.status === 503) {
        remaining.push(item); // erro de servidor/rede → tentar mais tarde
      } else {
        synced++; // 4xx (ex: já tinha clock-in) → descartar para não ficar preso
      }
    } catch {
      remaining.push(item); // sem rede → manter
    }
  }

  write(remaining);
  return synced;
}

/** Regista listeners para sincronizar automaticamente. Devolve cleanup. */
export function initOfflineSync(onChange?: (count: number) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleOnline = () => { void syncPendingTimesheets(); };
  const handleChange = (e: Event) => { onChange?.((e as CustomEvent<number>).detail); };

  window.addEventListener("online", handleOnline);
  window.addEventListener("pending-timesheets-changed", handleChange);

  // Tentativa inicial
  void syncPendingTimesheets();
  onChange?.(pendingCount());

  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("pending-timesheets-changed", handleChange);
  };
}
