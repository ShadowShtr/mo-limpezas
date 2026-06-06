import { describe, it, expect } from "vitest";
import { isValidCoord, calcServiceValue } from "@/lib/calculations";

// ── GPS coordinate validation ─────────────────────────────────────────────────
describe("GPS coordinate validation", () => {
  const valid: [number, number][] = [
    [38.7169, -9.1399],   // Lisboa
    [51.5074, -0.1278],   // Londres
    [-33.8688, 151.2093], // Sydney
    [90, 180],
    [-90, -180],
    [0, 0],
  ];

  const invalid: [number, number][] = [
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [NaN, 0],
    [0, NaN],
    [Infinity, 0],
    [0, -Infinity],
  ];

  it.each(valid)("accepts valid coord lat=%f lng=%f", (lat, lng) => {
    expect(isValidCoord(lat, lng)).toBe(true);
  });

  it.each(invalid)("rejects invalid coord lat=%f lng=%f", (lat, lng) => {
    expect(isValidCoord(lat, lng)).toBe(false);
  });
});

// ── Service value edge cases ──────────────────────────────────────────────────
describe("Service value edge cases", () => {
  it("5min × 18€/h × 1 colaborador ≈ 1.50€", () => {
    expect(calcServiceValue(5, 18, 1)).toBeCloseTo(1.5, 2);
  });

  it("480min (8h) × 15€/h × 4 colaboradores = 480€", () => {
    expect(calcServiceValue(480, 15, 4)).toBe(480.0);
  });

  it("0 duration returns 0", () => {
    expect(calcServiceValue(0, 20, 3)).toBe(0);
  });
});
