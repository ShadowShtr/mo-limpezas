import { describe, expect, it } from "vitest";
import { getMissingCashFlowReferenceIds, isValidCashFlowAmount } from "@/lib/cash-flow-integrity";

describe("cash flow integrity", () => {
  it("keeps only unpaid references not already registered", () => {
    expect(getMissingCashFlowReferenceIds(["a", "b", "b", "c"], ["b", null])).toEqual(["a", "c"]);
  });

  it("rejects invalid manual amounts", () => {
    expect(isValidCashFlowAmount(10)).toBe(true);
    expect(isValidCashFlowAmount(0)).toBe(false);
    expect(isValidCashFlowAmount(-1)).toBe(false);
    expect(isValidCashFlowAmount(Number.NaN)).toBe(false);
  });
});
