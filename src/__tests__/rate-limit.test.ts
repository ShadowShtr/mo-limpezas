import { describe, it, expect, beforeEach, vi } from "vitest";

// We need to reload the module to reset its in-memory store between tests.
// Use vi.resetModules() and dynamic imports for isolation.

describe("rateLimit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests under the limit", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-1");
    for (let i = 0; i < 5; i++) {
      expect(rateLimit(key, 5, 60_000)).toBeNull();
    }
  });

  it("blocks the request that exceeds the limit", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-2");
    for (let i = 0; i < 3; i++) rateLimit(key, 3, 60_000);
    const result = rateLimit(key, 3, 60_000);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  it("resets after the window expires", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-3");
    // Use a 1ms window so it expires immediately
    rateLimit(key, 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(rateLimit(key, 1, 1)).toBeNull();
  });

  it("different keys are independent", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key1 = rateLimitKey("test", "user-4a");
    const key2 = rateLimitKey("test", "user-4b");
    for (let i = 0; i < 2; i++) rateLimit(key1, 2, 60_000);
    // key1 exhausted
    expect(rateLimit(key1, 2, 60_000)).not.toBeNull();
    // key2 unaffected
    expect(rateLimit(key2, 2, 60_000)).toBeNull();
  });

  it("returns 429 with Retry-After header", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-5");
    rateLimit(key, 1, 60_000);
    const result = rateLimit(key, 1, 60_000);
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toBeTruthy();
  });
});
