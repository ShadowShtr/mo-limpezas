// @vitest-environment jsdom
import "fake-indexeddb/auto"; // jsdom não fornece IndexedDB — polyfill in-memory
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _evtSeq = 0;
function entry(
  service_id: string,
  kind: "in" | "out",
  lat = 38.7169,
  lng = -9.1399,
): Omit<import("@/lib/offline-sync").PendingTimesheet, "id" | "created_offline_at"> {
  return {
    kind,
    service_id,
    lat,
    lng,
    at: new Date(Date.now() - 5000).toISOString(),
    client_event_id: `test-evt-${++_evtSeq}`,
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // BD IndexedDB limpa por teste — evita acumular entradas entre testes
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── queueTimesheet ───────────────────────────────────────────────────────────

describe("queueTimesheet", () => {
  it("returns a PendingTimesheet with correct fields", async () => {
    const { queueTimesheet } = await import("@/lib/offline-sync");
    const e = entry("svc-42", "out", 38.72, -9.14);
    const item = await queueTimesheet(e);
    expect(item.service_id).toBe("svc-42");
    expect(item.kind).toBe("out");
    expect(item.lat).toBe(38.72);
    expect(item.lng).toBe(-9.14);
    expect(typeof item.id).toBe("string");
  });

  it("assigns unique ids even for same service + kind", async () => {
    const { queueTimesheet } = await import("@/lib/offline-sync");
    const a = await queueTimesheet(entry("svc-1", "in"));
    await new Promise((r) => setTimeout(r, 2));
    const b = await queueTimesheet(entry("svc-1", "in"));
    expect(a.id).not.toBe(b.id);
  });

  it("starts with empty pendingCount (IDB is async — pendingCount is a stub)", async () => {
    const { pendingCount } = await import("@/lib/offline-sync");
    expect(pendingCount()).toBe(0);
  });
});

// ─── syncPendingTimesheets ────────────────────────────────────────────────────

describe("syncPendingTimesheets — online", () => {
  it("successful 200 → synced count 1", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-ok", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(1);
  });

  it("409 conflict → counts as resolved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-409", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(1);
  });

  it("4xx error → discarded (non-retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-400", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBeGreaterThanOrEqual(1);
  });

  it("500 server error → entry kept for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-500", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(0);
  });

  it("503 server error → entry kept for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-503", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(0);
  });

  it("network exception → entry kept", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-net", "in"));
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(0);
  });

  it("empty queue → synced count is 0", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { syncPendingTimesheets } = await import("@/lib/offline-sync");
    expect(await syncPendingTimesheets()).toBe(0);
  });

  it("clock-in uses POST method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-method", "in"));
    await syncPendingTimesheets();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/app/timesheet",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clock-out uses PATCH method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    await queueTimesheet(entry("svc-method-out", "out"));
    await syncPendingTimesheets();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/app/timesheet",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});

describe("syncPendingTimesheets — offline", () => {
  it("skips sync when navigator.onLine is false", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");
    await queueTimesheet(entry("svc-offline", "in"));
    const synced = await syncPendingTimesheets();

    expect(synced).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  });
});

describe("syncPendingTimesheets — 35 collaborators", () => {
  it("all 70 entries sync successfully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    for (let i = 0; i < 35; i++) {
      await queueTimesheet(entry(`svc-${i}`, "in"));
      await queueTimesheet(entry(`svc-${i}`, "out"));
    }
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(70);
  });
});

// ─── initOfflineSync ──────────────────────────────────────────────────────────

describe("initOfflineSync", () => {
  it("returns a cleanup function", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { initOfflineSync } = await import("@/lib/offline-sync");
    const cleanup = initOfflineSync();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});
