import { describe, it, expect, beforeEach, vi } from "vitest";

// Reload the module between tests to reset the in-memory store.
describe("rateLimit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests under the limit", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-1");
    for (let i = 0; i < 5; i++) {
      expect(await rateLimit(key, 5, 60_000)).toBeNull();
    }
  });

  it("blocks the request that exceeds the limit", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-2");
    for (let i = 0; i < 3; i++) await rateLimit(key, 3, 60_000);
    const result = await rateLimit(key, 3, 60_000);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  it("resets after the window expires", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-3");
    await rateLimit(key, 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await rateLimit(key, 1, 1)).toBeNull();
  });

  it("different keys are independent", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key1 = rateLimitKey("test", "user-4a");
    const key2 = rateLimitKey("test", "user-4b");
    for (let i = 0; i < 2; i++) await rateLimit(key1, 2, 60_000);
    expect(await rateLimit(key1, 2, 60_000)).not.toBeNull();
    expect(await rateLimit(key2, 2, 60_000)).toBeNull();
  });

  it("returns 429 with Retry-After header", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("test", "user-5");
    await rateLimit(key, 1, 60_000);
    const result = await rateLimit(key, 1, 60_000);
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toBeTruthy();
  });
});
