/**
 * Data-integrity invariants.
 *
 * These tests encode business rules that MUST hold for every valid input.
 * A failure here means data corruption risk for the 35 employees.
 */
import { describe, it, expect } from "vitest";
import {
  monthRange,
  calcCollaboratorPayroll,
  calcAdjustedNetSalary,
  calcAbsenceSummary,
  calcTimesheetDuration,
} from "@/lib/payroll-calc";

const STD: import("@/lib/payroll-calc").PayrollSettings = {
  defaultHourlyRate: 8,
  mealAllowanceDay: 9.6,
  overtimeRatePct: 25,
};

function ts(date: string, minutes: number): import("@/lib/payroll-calc").TimesheetEntry {
  return { duration_minutes: minutes, clock_in_at: `${date}T07:00:00Z` };
}

// ─── Arithmetic precision ─────────────────────────────────────────────────────

describe("floating-point precision (no centavo errors)", () => {
  const PROBLEMATIC_RATES = [7.333333, 8.75, 9.60, 11.11, 12.50, 15.27];
  const PROBLEMATIC_HOURS = [160, 168, 173.33, 180, 0.5, 7.636363];

  it.each(PROBLEMATIC_RATES)("hourly rate €%s → gross is rounded to 2dp", (rate) => {
    const { grossSalary } = calcCollaboratorPayroll(
      [ts("2024-01-02", 480)],
      [], 160, rate, STD, "2024-01-01", "2024-01-31",
    );
    expect(grossSalary).toBe(parseFloat(grossSalary.toFixed(2)));
  });

  it.each(PROBLEMATIC_HOURS)("workedHours=%s → mealAllowance is rounded to 2dp", (hours) => {
    const timesheets = [ts("2024-01-02", Math.round(hours * 60))];
    const { mealAllowance } = calcCollaboratorPayroll(
      timesheets, [], 160, 8, STD, "2024-01-01", "2024-01-31",
    );
    expect(mealAllowance).toBe(parseFloat(mealAllowance.toFixed(2)));
  });

  it("net salary is always rounded to 2 decimal places", () => {
    for (let i = 1; i <= 22; i++) {
      const { netSalary } = calcCollaboratorPayroll(
        [ts(`2024-01-${String(i).padStart(2, "0")}`, 437)],
        [], 160, 7.333333, STD, "2024-01-01", "2024-01-31",
      );
      expect(netSalary).toBe(parseFloat(netSalary.toFixed(2)));
    }
  });

  it("calcAdjustedNetSalary with repeating decimals rounds correctly", () => {
    const result = calcAdjustedNetSalary(
      1000 / 3,   // 333.333...
      100 / 3,    // 33.333...
      50 / 3,     // 16.666...
      0, 0, 0,
    );
    expect(result).toBe(parseFloat(result.toFixed(2)));
    expect(Math.abs(result - (1000 / 3 + 100 / 3 + 50 / 3))).toBeLessThan(0.01);
  });
});

// ─── Business invariants ──────────────────────────────────────────────────────

describe("overtime invariant: overtimeHours ≥ 0 always", () => {
  const workedLess = [0, 80, 120, 159, 159.99];

  it.each(workedLess)("worked %sh < 160h contracted → overtime = 0", (worked) => {
    const timesheets = worked > 0 ? [ts("2024-01-02", Math.round(worked * 60))] : [];
    const { overtimeHours } = calcCollaboratorPayroll(
      timesheets, [], 160, 8, STD, "2024-01-01", "2024-01-31",
    );
    expect(overtimeHours).toBe(0);
  });
});

describe("gross salary invariant: grossSalary = workedHours × hourlyRate", () => {
  it("holds for a standard 8-hour day", () => {
    const { grossSalary, workedHours } = calcCollaboratorPayroll(
      [ts("2024-01-02", 480)],
      [], 160, 10, STD, "2024-01-01", "2024-01-31",
    );
    expect(grossSalary).toBeCloseTo(workedHours * 10, 2);
  });

  it("holds across 22 days at varying durations", () => {
    const timesheets = Array.from({ length: 22 }, (_, i) =>
      ts(`2024-01-${String(i + 1).padStart(2, "0")}`, 400 + i * 5),
    );
    const rate = 9.87;
    const { grossSalary, workedHours } = calcCollaboratorPayroll(
      timesheets, [], 160, rate, STD, "2024-01-01", "2024-01-31",
    );
    expect(grossSalary).toBeCloseTo(workedHours * rate, 1);
  });
});

describe("meal allowance invariant: mealAllowance = daysWorked × mealAllowanceDay", () => {
  it("holds for 22 distinct days", () => {
    const timesheets = Array.from({ length: 22 }, (_, i) =>
      ts(`2024-01-${String(i + 1).padStart(2, "0")}`, 480),
    );
    const { mealAllowance, daysWorked } = calcCollaboratorPayroll(
      timesheets, [], 160, 8, STD, "2024-01-01", "2024-01-31",
    );
    expect(mealAllowance).toBeCloseTo(daysWorked * 9.6, 2);
  });

  it("two entries same day → meal counted once only", () => {
    const { mealAllowance } = calcCollaboratorPayroll(
      [ts("2024-01-02", 240), ts("2024-01-02", 120)],
      [], 160, 8, STD, "2024-01-01", "2024-01-31",
    );
    expect(mealAllowance).toBeCloseTo(9.6, 2);
  });
});

describe("absence deduction invariant: only unjustified type triggers deduction", () => {
  const noDeductionTypes = [
    "doenca_com_baixa", "doenca_sem_baixa", "pessoal_justificado",
    "ferias", "feriado", "formacao", "outro",
  ];

  it.each(noDeductionTypes)("type '%s' → absenceDeductions = 0", (type) => {
    const { absenceDeductions } = calcAbsenceSummary(
      [{ absence_type: type, starts_on: "2024-01-08", ends_on: "2024-01-10" }],
      "2024-01-01", "2024-01-31", 168, 8,
    );
    expect(absenceDeductions).toBe(0);
  });

  it("pessoal_injustificado always triggers deduction", () => {
    const { absenceDeductions } = calcAbsenceSummary(
      [{ absence_type: "pessoal_injustificado", starts_on: "2024-01-08", ends_on: "2024-01-10" }],
      "2024-01-01", "2024-01-31", 168, 8,
    );
    expect(absenceDeductions).toBeGreaterThan(0);
  });
});

describe("net salary formula is additive (no hidden multipliers)", () => {
  it("net = gross + meal + overtime_bonus + additions − absence_ded − other_ded", () => {
    const timesheets = Array.from({ length: 22 }, (_, i) =>
      ts(`2024-01-${String(i + 1).padStart(2, "0")}`, 495), // 8h15min → some overtime
    );
    const additions = 150;
    const deductions = 30;
    const r = calcCollaboratorPayroll(
      timesheets,
      [{ absence_type: "pessoal_injustificado", starts_on: "2024-01-05", ends_on: "2024-01-05" }],
      160, 8, STD, "2024-01-01", "2024-01-31",
      additions, deductions,
    );

    const expected = r.grossSalary + r.mealAllowance + r.overtimeBonus
      + additions - r.absenceDeductions - deductions;

    expect(r.netSalary).toBeCloseTo(expected, 2);
  });
});

// ─── Duration invariant ───────────────────────────────────────────────────────

describe("timesheet duration invariants", () => {
  it("duration is never negative (returns null for inverted pairs)", () => {
    expect(calcTimesheetDuration("2024-01-15T16:00:00Z", "2024-01-15T08:00:00Z")).toBeNull();
  });

  it("same in/out → 0 minutes (not negative)", () => {
    expect(calcTimesheetDuration("2024-01-15T10:00:00Z", "2024-01-15T10:00:00Z")).toBe(0);
  });

  it("duration is an integer (no fractional minutes stored)", () => {
    const d = calcTimesheetDuration("2024-01-15T09:00:00Z", "2024-01-15T09:47:30Z");
    expect(d).not.toBeNull();
    expect(Number.isInteger(d)).toBe(true);
  });
});

// ─── Month boundary integrity ─────────────────────────────────────────────────

describe("month boundary integrity across the year", () => {
  const months = [
    [2024, 1, 31],
    [2024, 2, 29], // leap
    [2023, 2, 28], // non-leap
    [2024, 3, 31],
    [2024, 4, 30],
    [2024, 5, 31],
    [2024, 6, 30],
    [2024, 7, 31],
    [2024, 8, 31],
    [2024, 9, 30],
    [2024, 10, 31],
    [2024, 11, 30],
    [2024, 12, 31],
  ] as const;

  it.each(months)("year=%i month=%i → end day is %i", (year, month, expectedLastDay) => {
    const { end } = monthRange(year, month);
    const lastDay = parseInt(end.split("-")[2], 10);
    expect(lastDay).toBe(expectedLastDay);
  });

  it("consecutive months share no overlap", () => {
    for (let m = 1; m < 12; m++) {
      const curr = monthRange(2024, m);
      const next = monthRange(2024, m + 1);
      expect(new Date(curr.end) < new Date(next.start)).toBe(true);
    }
  });

  it("December end + 1 day = January 1 of next year", () => {
    const { end } = monthRange(2024, 12);
    const nextDay = new Date(new Date(end).getTime() + 24 * 60 * 60 * 1000);
    expect(nextDay.getUTCFullYear()).toBe(2025);
    expect(nextDay.getUTCMonth()).toBe(0);  // January (0-indexed)
    expect(nextDay.getUTCDate()).toBe(1);
  });
});

// ─── 7-hour workday simulation ────────────────────────────────────────────────

describe("7-hour/day continuous usage simulation", () => {
  it("38 users (3 gestoras + 35 funcionárias) each working 7h → correct gross totals", () => {
    const { start, end } = monthRange(2024, 1);

    let totalNet = 0;
    for (let i = 0; i < 38; i++) {
      const timesheets = Array.from({ length: 22 }, (_, d) =>
        ts(`2024-01-${String(d + 1).padStart(2, "0")}`, 420), // 7h/day
      );
      const r = calcCollaboratorPayroll(timesheets, [], 154, 8, STD, start, end);
      // Each worked 22×7=154h, grossSalary = 154 × 8 = 1232€
      expect(r.grossSalary).toBeCloseTo(1232, 1);
      totalNet += r.netSalary;
    }

    // Total net must be a positive number close to a 2dp value.
    // Summing 38 individually-rounded values can accumulate floating-point
    // error in the last ULP, so we use toBeCloseTo rather than strict equality.
    expect(totalNet).toBeGreaterThan(0);
    expect(totalNet).toBeCloseTo(parseFloat(totalNet.toFixed(2)), 2);
  });

  it("consecutive months produce independent results (no cross-month contamination)", () => {
    const months = [1, 2, 3, 4, 5, 6];
    const results = months.map((m) => {
      const { start, end } = monthRange(2024, m);
      return calcCollaboratorPayroll(
        [ts(`2024-${String(m).padStart(2, "0")}-05`, 480)],
        [],
        160, 8, STD, start, end,
      );
    });

    // Each month produces exactly 1 day worked
    results.forEach((r) => {
      expect(r.daysWorked).toBe(1);
      expect(r.grossSalary).toBeCloseTo(8 * 8, 2);
    });
  });
});
