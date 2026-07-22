import { describe, it, expect } from "vitest";
import { calcVacationEntitlement } from "@/lib/vacation-entitlement";

describe("calcVacationEntitlement", () => {
  it("gives the full 22 days for years after the hire year", () => {
    expect(calcVacationEntitlement("2020-01-01", 2026)).toBe(22);
    expect(calcVacationEntitlement("2025-12-31", 2026)).toBe(22);
  });

  it("gives 0 for a year before the hire year", () => {
    expect(calcVacationEntitlement("2026-03-01", 2025)).toBe(0);
  });

  it("caps the admission-year entitlement at 20 days for someone hired Jan 1st", () => {
    // Jan 1 -> Dec 31 = 11 complete months -> min(20, 22) = 20
    expect(calcVacationEntitlement("2026-01-01", 2026)).toBe(20);
  });

  it("gives 0 in the admission year when fewer than 6 complete months are worked", () => {
    // July 1 -> Dec 31 = 5 complete months, below the 6-month threshold
    expect(calcVacationEntitlement("2026-07-01", 2026)).toBe(0);
  });

  it("gives 2 days per complete month once the 6-month threshold is reached", () => {
    // June 15 -> Dec 31 = 6 complete months -> 12 days
    expect(calcVacationEntitlement("2026-06-15", 2026)).toBe(12);
    // May 1 -> Dec 31 = 7 complete months -> 14 days
    expect(calcVacationEntitlement("2026-05-01", 2026)).toBe(14);
  });

  it("handles month-end start dates (e.g. Jan 31st) using the standard calendar convention", () => {
    // Jan 31 -> Dec 31 = 11 anniversaries reached (Feb 28 counts as reaching the 31st) -> min(20, 22) = 20
    expect(calcVacationEntitlement("2026-01-31", 2026)).toBe(20);
  });
});
