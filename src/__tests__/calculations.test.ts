import { describe, it, expect } from "vitest";
import {
  haversineDistanceM,
  calcServiceValue,
  calcMonthlyGross,
  isValidCoord,
} from "@/lib/calculations";

describe("haversineDistanceM", () => {
  it("returns ~0 for same coordinates", () => {
    expect(haversineDistanceM(38.7169, -9.1399, 38.7169, -9.1399)).toBeCloseTo(0, 0);
  });

  it("returns roughly 13m for very close points in Lisbon", () => {
    const d = haversineDistanceM(38.7169, -9.1399, 38.7170, -9.1400);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(30);
  });

  it("returns roughly 111km per degree of latitude", () => {
    const d = haversineDistanceM(38.0, -9.0, 39.0, -9.0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("handles negative coordinates (southern hemisphere)", () => {
    const d = haversineDistanceM(-23.5505, -46.6333, -23.5506, -46.6334);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(30);
  });
});

describe("calcServiceValue", () => {
  it("120min × 15€/h × 2 colaboradores = 60€", () => {
    expect(calcServiceValue(120, 15.0, 2)).toBe(60.0);
  });

  it("90min × 18€/h × 3 colaboradores = 81€", () => {
    expect(calcServiceValue(90, 18.0, 3)).toBe(81.0);
  });

  it("0 minutes returns 0", () => {
    expect(calcServiceValue(0, 20, 2)).toBe(0);
  });

  it("rounds to 2 decimal places", () => {
    expect(calcServiceValue(70, 17, 1)).toBe(
      parseFloat(((70 / 60) * 17 * 1).toFixed(2))
    );
  });
});

describe("calcMonthlyGross", () => {
  it("160h × 8€ + 22 dias × 9.60 = 1491.20€", () => {
    expect(calcMonthlyGross(160, 8, 22, 9.6)).toBe(1491.2);
  });

  it("0 hours still counts meal allowance", () => {
    expect(calcMonthlyGross(0, 8, 10, 9.6)).toBe(96.0);
  });

  it("0 meal days has no allowance", () => {
    expect(calcMonthlyGross(160, 8, 0, 9.6)).toBe(1280.0);
  });
});

describe("isValidCoord", () => {
  it("accepts valid Lisbon coordinates", () => {
    expect(isValidCoord(38.7169, -9.1399)).toBe(true);
  });

  it("accepts edge values (poles and antimeridian)", () => {
    expect(isValidCoord(-90, -180)).toBe(true);
    expect(isValidCoord(90, 180)).toBe(true);
  });

  it("rejects lat > 90", () => {
    expect(isValidCoord(91, 0)).toBe(false);
  });

  it("rejects lng > 180", () => {
    expect(isValidCoord(0, 200)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidCoord(NaN, 0)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidCoord(Infinity, 0)).toBe(false);
  });
});
