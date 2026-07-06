import { describe, it, expect } from "vitest";
import { addDaysToDateString, lisbonOffset, toLisbonTimestamp } from "@/lib/lisbon-time";

describe("addDaysToDateString", () => {
  it("soma 1 dia sem desvio, mesmo em hora de verão (regressão 2026-07-06)", () => {
    // Bug original: new Date(`${d}T00:00:00`) interpretava a data como meia-
    // -noite de Lisboa (UTC+1 no verão) e formatava com .toISOString() (UTC),
    // devolvendo sempre o dia anterior. addDaysToDateString usa Date.UTC, que
    // não depende do fuso do processo a correr o código.
    expect(addDaysToDateString("2026-07-06", 0)).toBe("2026-07-06");
    expect(addDaysToDateString("2026-07-06", 1)).toBe("2026-07-07");
  });

  it("soma 1 dia corretamente em hora de inverno também", () => {
    expect(addDaysToDateString("2026-01-15", 1)).toBe("2026-01-16");
  });

  it("atravessa a virada do mês e do ano corretamente", () => {
    expect(addDaysToDateString("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysToDateString("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("suporta subtração de dias (delta negativo)", () => {
    expect(addDaysToDateString("2026-07-06", -1)).toBe("2026-07-05");
  });
});

describe("lisbonOffset / toLisbonTimestamp (comportamento já existente, referência)", () => {
  it("usa +01:00 no verão e +00:00 no inverno", () => {
    expect(lisbonOffset("2026-07-06")).toBe("+01:00");
    expect(lisbonOffset("2026-01-15")).toBe("+00:00");
  });

  it("compõe data+hora com o offset correto", () => {
    expect(toLisbonTimestamp("2026-07-06", "09:00")).toBe("2026-07-06T09:00:00+01:00");
  });
});
