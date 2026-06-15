// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal PendingTimesheet-like object without the id field. */
function entry(
  service_id: string,
  kind: "in" | "out",
  lat = 38.7169,
  lng = -9.1399,
): Omit<import("@/lib/offline-sync").PendingTimesheet, "id"> {
  return {
    kind,
    service_id,
    lat,
    lng,
    at: new Date(Date.now() - 5000).toISOString(),
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── queueTimesheet & pendingCount ───────────────────────────────────────────

describe("queueTimesheet and pendingCount", () => {
  it("starts with an empty queue", async () => {
    const { pendingCount } = await import("@/lib/offline-sync");
    expect(pendingCount()).toBe(0);
  });

  it("queuing one entry → count = 1", async () => {
    const { queueTimesheet, pendingCount } = await import("@/lib/offline-sync");
    queueTimesheet(entry("svc-1", "in"));
    expect(pendingCount()).toBe(1);
  });

  it("queuing two entries → count = 2", async () => {
    const { queueTimesheet, pendingCount } = await import("@/lib/offline-sync");
    queueTimesheet(entry("svc-1", "in"));
    queueTimesheet(entry("svc-1", "out"));
    expect(pendingCount()).toBe(2);
  });

  it("assigns unique ids even for same service + kind", async () => {
    const { queueTimesheet } = await import("@/lib/offline-sync");
    const a = queueTimesheet(entry("svc-1", "in"));
    await new Promise((r) => setTimeout(r, 2)); // guarantee different Date.now()
    const b = queueTimesheet(entry("svc-1", "in"));
    expect(a.id).not.toBe(b.id);
  });

  it("returned item has all queued fields", async () => {
    const { queueTimesheet } = await import("@/lib/offline-sync");
    const e = entry("svc-42", "out", 38.72, -9.14);
    const item = queueTimesheet(e);
    expect(item.service_id).toBe("svc-42");
    expect(item.kind).toBe("out");
    expect(item.lat).toBe(38.72);
    expect(item.lng).toBe(-9.14);
    expect(typeof item.id).toBe("string");
  });

  it("35 collaborators each queuing clock-in and clock-out → 70 entries", async () => {
    const { queueTimesheet, pendingCount } = await import("@/lib/offline-sync");
    for (let i = 0; i < 35; i++) {
      queueTimesheet(entry(`svc-${i}`, "in"));
      queueTimesheet(entry(`svc-${i}`, "out"));
    }
    expect(pendingCount()).toBe(70);
  });

  it("queue survives module re-import (persisted in localStorage)", async () => {
    const mod1 = await import("@/lib/offline-sync");
    mod1.queueTimesheet(entry("svc-persist", "in"));
    // Re-import same module (not reset) should see same localStorage
    const mod2 = await import("@/lib/offline-sync");
    expect(mod2.pendingCount()).toBe(1);
  });
});

// ─── syncPendingTimesheets ────────────────────────────────────────────────────

describe("syncPendingTimesheets — online", () => {
  it("successful 200 → removes entry from queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-ok", "in"));
    const synced = await syncPendingTimesheets();

    expect(synced).toBe(1);
    expect(pendingCount()).toBe(0);
  });

  it("409 conflict (already synced) → counts as resolved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-409", "in"));
    const synced = await syncPendingTimesheets();

    expect(synced).toBe(1);
    expect(pendingCount()).toBe(0);
  });

  it("4xx error → discards entry (non-retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-400", "in"));
    const synced = await syncPendingTimesheets();

    expect(synced).toBeGreaterThanOrEqual(1); // counted as resolved (discarded)
    expect(pendingCount()).toBe(0);
  });

  it("500 server error → keeps entry in queue for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-500", "in"));
    await syncPendingTimesheets();

    expect(pendingCount()).toBe(1);
  });

  it("503 server error → keeps entry in queue for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-503", "in"));
    await syncPendingTimesheets();

    expect(pendingCount()).toBe(1);
  });

  it("network exception → keeps entry in queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-net", "in"));
    await syncPendingTimesheets();

    expect(pendingCount()).toBe(1);
  });

  it("empty queue → synced count is 0", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { syncPendingTimesheets } = await import("@/lib/offline-sync");
    const synced = await syncPendingTimesheets();
    expect(synced).toBe(0);
  });

  it("mixed results: 2 ok + 1 error → 2 removed, 1 kept", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      call++;
      if (call === 2) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200 });
    }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-a", "in"));
    queueTimesheet(entry("svc-b", "in"));
    queueTimesheet(entry("svc-c", "in"));

    const synced = await syncPendingTimesheets();
    expect(synced).toBe(2);
    expect(pendingCount()).toBe(1);
  });

  it("clock-in uses POST method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    const { queueTimesheet, syncPendingTimesheets } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-method", "in"));
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

    queueTimesheet(entry("svc-method-out", "out"));
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

    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");
    queueTimesheet(entry("svc-offline", "in"));
    const synced = await syncPendingTimesheets();

    expect(synced).toBe(0);
    expect(pendingCount()).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  });
});

describe("syncPendingTimesheets — 35 collaborators data integrity", () => {
  it("all 70 entries sync successfully → queue is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    for (let i = 0; i < 35; i++) {
      queueTimesheet(entry(`svc-${i}`, "in"));
      queueTimesheet(entry(`svc-${i}`, "out"));
    }
    expect(pendingCount()).toBe(70);

    const synced = await syncPendingTimesheets();
    expect(synced).toBe(70);
    expect(pendingCount()).toBe(0);
  });

  it("intermittent failures: retrying recovers all data", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      attempt++;
      // Fail every 7th request (simulate flaky network)
      if (attempt % 7 === 0) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({ ok: true, status: 200 });
    }));

    const { queueTimesheet, syncPendingTimesheets, pendingCount } = await import("@/lib/offline-sync");

    for (let i = 0; i < 35; i++) {
      queueTimesheet(entry(`svc-${i}`, "in"));
      queueTimesheet(entry(`svc-${i}`, "out"));
    }

    // First sync — some fail
    await syncPendingTimesheets();
    const remaining = pendingCount();
    expect(remaining).toBeGreaterThan(0); // some were kept

    // Second sync — all remaining succeed
    attempt = 1; // reset counter so no more failures divisible by 7
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { syncPendingTimesheets: sync2 } = await import("@/lib/offline-sync");
    await sync2();
    expect(pendingCount()).toBe(0);
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

  it("calls onChange with initial pending count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { queueTimesheet, initOfflineSync } = await import("@/lib/offline-sync");

    queueTimesheet(entry("svc-init", "in"));
    queueTimesheet(entry("svc-init", "out"));

    const counts: number[] = [];
    const cleanup = initOfflineSync((n) => counts.push(n));
    cleanup();

    // Initial count should be 2
    expect(counts[0]).toBe(2);
  });
});
