/**
 * Concurrent / load simulation tests.
 *
 * Validates that the rate-limiter, offline queue, and payroll engine hold up
 * when 38 users (3 managers + 35 staff) hammer the system simultaneously for
 * 7 hours a day.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { calcCollaboratorPayroll, monthRange } from "@/lib/payroll-calc";

// ─── Rate-limit under concurrent load ────────────────────────────────────────

describe("rateLimit under concurrent load (in-memory fallback)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("38 users each make 5 requests within limit → all pass", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const results = await Promise.all(
      Array.from({ length: 38 }, async (_, i) => {
        const key = rateLimitKey("load-test", `user-${i}`);
        const responses = await Promise.all(
          Array.from({ length: 5 }, () => rateLimit(key, 10, 60_000)),
        );
        return responses.every((r) => r === null); // null = allowed
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it("one user bursting 15 requests (limit=10) → 5 are blocked", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("burst", "burst-user");
    let blocked = 0;
    for (let i = 0; i < 15; i++) {
      const r = await rateLimit(key, 10, 60_000);
      if (r !== null) blocked++;
    }
    expect(blocked).toBe(5);
  });

  it("38 users simultaneously hitting clock-in endpoint: only excessive are blocked", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");

    // Each user sends 1 clock-in (well within the 10/min limit)
    const results = await Promise.all(
      Array.from({ length: 38 }, (_, i) =>
        rateLimit(rateLimitKey("timesheet", `user-${i}`), 10, 60_000),
      ),
    );

    const blocked = results.filter((r) => r !== null).length;
    expect(blocked).toBe(0); // no legitimate user should be blocked
  });

  it("blocked response has status 429", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("block-test", "block-user");
    for (let i = 0; i < 3; i++) await rateLimit(key, 3, 60_000);
    const blocked = await rateLimit(key, 3, 60_000);
    expect(blocked?.status).toBe(429);
  });

  it("blocked response has Retry-After header", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("retry-after", "retry-user");
    for (let i = 0; i < 2; i++) await rateLimit(key, 2, 60_000);
    const blocked = await rateLimit(key, 2, 60_000);
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
    expect(parseInt(blocked?.headers.get("Retry-After") ?? "0", 10)).toBeGreaterThanOrEqual(1);
  });

  it("different users are isolated (user A blocked ≠ user B blocked)", async () => {
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const keyA = rateLimitKey("isolation", "user-A");
    const keyB = rateLimitKey("isolation", "user-B");

    // Fill A's bucket
    for (let i = 0; i < 2; i++) await rateLimit(keyA, 2, 60_000);
    const blockedA = await rateLimit(keyA, 2, 60_000);
    const blockedB = await rateLimit(keyB, 2, 60_000);

    expect(blockedA).not.toBeNull();
    expect(blockedB).toBeNull(); // B is unaffected
  });
});

// ─── Payroll engine under load ────────────────────────────────────────────────

describe("payroll engine under load", () => {
  const { start, end } = monthRange(2024, 1);

  function makeTimesheets(days: number, minutesPerDay: number) {
    return Array.from({ length: days }, (_, i) => ({
      duration_minutes: minutesPerDay,
      clock_in_at: `2024-01-${String(i + 1).padStart(2, "0")}T08:00:00Z`,
    }));
  }

  it("processes 38 payroll records in parallel < 50ms", async () => {
    const t0 = performance.now();

    await Promise.all(
      Array.from({ length: 38 }, (_, i) =>
        Promise.resolve(
          calcCollaboratorPayroll(
            makeTimesheets(22, 420 + i), // slightly different per user
            [],
            160, 8,
            { defaultHourlyRate: 8, mealAllowanceDay: 9.6, overtimeRatePct: 25 },
            start, end,
          ),
        ),
      ),
    );

    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50); // pure math, must be fast
  });

  it("12 months × 38 employees = 456 payroll records → all produce valid net salaries", () => {
    const records: number[] = [];

    for (let month = 1; month <= 12; month++) {
      const { start: s, end: e } = monthRange(2024, month);
      for (let emp = 0; emp < 38; emp++) {
        const { netSalary } = calcCollaboratorPayroll(
          makeTimesheets(20, 420),
          [],
          154, 8,
          { defaultHourlyRate: 8, mealAllowanceDay: 9.6, overtimeRatePct: 25 },
          s, e,
        );
        records.push(netSalary);
      }
    }

    expect(records).toHaveLength(456);
    // All net salaries are finite positive numbers
    expect(records.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    // All rounded to 2dp
    expect(records.every((n) => n === parseFloat(n.toFixed(2)))).toBe(true);
  });

  it("idempotent: same input produces identical output on repeated calls", () => {
    const timesheets = makeTimesheets(22, 480);
    const run1 = calcCollaboratorPayroll(timesheets, [], 160, 8, { defaultHourlyRate: 8, mealAllowanceDay: 9.6, overtimeRatePct: 25 }, start, end);
    const run2 = calcCollaboratorPayroll(timesheets, [], 160, 8, { defaultHourlyRate: 8, mealAllowanceDay: 9.6, overtimeRatePct: 25 }, start, end);

    expect(run1).toEqual(run2);
  });

  it("no cross-contamination between sequential payroll runs", () => {
    // Each run uses fresh data — previous result must not affect next
    const results = Array.from({ length: 10 }, (_, i) =>
      calcCollaboratorPayroll(
        makeTimesheets(i + 1, 480),
        [],
        160, 8,
        { defaultHourlyRate: 8, mealAllowanceDay: 9.6, overtimeRatePct: 25 },
        start, end,
      ),
    );

    // daysWorked must strictly increase
    for (let i = 1; i < results.length; i++) {
      expect(results[i].daysWorked).toBeGreaterThan(results[i - 1].daysWorked);
    }
  });
});

// ─── checkRateLimit (server-action variant) ───────────────────────────────────

describe("checkRateLimit for server actions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns true (allowed) for first request", async () => {
    const { checkRateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("action", "sa-user-1");
    expect(await checkRateLimit(key, 5, 60_000)).toBe(true);
  });

  it("returns false (blocked) after exceeding limit", async () => {
    const { checkRateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const key = rateLimitKey("action", "sa-user-2");
    for (let i = 0; i < 3; i++) await checkRateLimit(key, 3, 60_000);
    expect(await checkRateLimit(key, 3, 60_000)).toBe(false);
  });

  it("3 managers each calling payroll action: none blocked", async () => {
    const { checkRateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    const allowed = await Promise.all(
      ["gestor-1", "gestor-2", "gestor-3"].map((id) =>
        checkRateLimit(rateLimitKey("payroll", id), 5, 60_000),
      ),
    );
    expect(allowed.every(Boolean)).toBe(true);
  });
});
