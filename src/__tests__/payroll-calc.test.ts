import { describe, it, expect } from "vitest";
import {
  monthRange,
  calcTimesheetDuration,
  calcAbsenceSummary,
  calcCollaboratorPayroll,
  calcAdjustedNetSalary,
  normalisePastTimestamp,
  parseCoord,
} from "@/lib/payroll-calc";

// ─── Default settings used throughout ────────────────────────────────────────

const STD: import("@/lib/payroll-calc").PayrollSettings = {
  defaultHourlyRate: 8,
  mealAllowanceDay: 9.6,
  overtimeRatePct: 25,
};

// ─── monthRange ───────────────────────────────────────────────────────────────

describe("monthRange", () => {
  it("January 2024: 31 days", () => {
    expect(monthRange(2024, 1)).toEqual({ start: "2024-01-01", end: "2024-01-31" });
  });

  it("February 2024 (leap year): 29 days", () => {
    expect(monthRange(2024, 2)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });

  it("February 2023 (non-leap): 28 days", () => {
    expect(monthRange(2023, 2)).toEqual({ start: "2023-02-01", end: "2023-02-28" });
  });

  it("February 2100 (non-leap century): 28 days", () => {
    expect(monthRange(2100, 2)).toEqual({ start: "2100-02-01", end: "2100-02-28" });
  });

  it("February 2000 (leap century): 29 days", () => {
    expect(monthRange(2000, 2)).toEqual({ start: "2000-02-01", end: "2000-02-29" });
  });

  it("March: 31 days", () => {
    expect(monthRange(2024, 3)).toEqual({ start: "2024-03-01", end: "2024-03-31" });
  });

  it("April: 30 days", () => {
    expect(monthRange(2024, 4)).toEqual({ start: "2024-04-01", end: "2024-04-30" });
  });

  it("June: 30 days (summer month — timezone-safe)", () => {
    expect(monthRange(2024, 6)).toEqual({ start: "2024-06-01", end: "2024-06-30" });
  });

  it("September: 30 days", () => {
    expect(monthRange(2024, 9)).toEqual({ start: "2024-09-01", end: "2024-09-30" });
  });

  it("October: 31 days (DST transition in Portugal)", () => {
    expect(monthRange(2024, 10)).toEqual({ start: "2024-10-01", end: "2024-10-31" });
  });

  it("November: 30 days", () => {
    expect(monthRange(2024, 11)).toEqual({ start: "2024-11-01", end: "2024-11-30" });
  });

  it("December: 31 days (year end)", () => {
    expect(monthRange(2024, 12)).toEqual({ start: "2024-12-01", end: "2024-12-31" });
  });

  it("start and end are well-formed ISO date strings", () => {
    const { start, end } = monthRange(2024, 7);
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("end is always >= start", () => {
    for (let m = 1; m <= 12; m++) {
      const { start, end } = monthRange(2024, m);
      expect(new Date(end) >= new Date(start)).toBe(true);
    }
  });
});

// ─── calcTimesheetDuration ────────────────────────────────────────────────────

describe("calcTimesheetDuration", () => {
  it("8-hour shift → 480 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T08:00:00Z", "2024-01-15T16:00:00Z")).toBe(480);
  });

  it("4-hour shift → 240 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T09:00:00Z", "2024-01-15T13:00:00Z")).toBe(240);
  });

  it("30-minute service → 30 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T10:00:00Z", "2024-01-15T10:30:00Z")).toBe(30);
  });

  it("midnight-crossing shift (22:00 → 06:00) → 480 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T22:00:00Z", "2024-01-16T06:00:00Z")).toBe(480);
  });

  it("same clock-in and clock-out → 0 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T10:00:00Z", "2024-01-15T10:00:00Z")).toBe(0);
  });

  it("returns null when clock-out is before clock-in (invalid)", () => {
    expect(calcTimesheetDuration("2024-01-15T16:00:00Z", "2024-01-15T08:00:00Z")).toBeNull();
  });

  it("1-second shift → 0 minutes (rounds down)", () => {
    expect(calcTimesheetDuration("2024-01-15T10:00:00Z", "2024-01-15T10:00:01Z")).toBe(0);
  });

  it("long shift (12h) → 720 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T06:00:00Z", "2024-01-15T18:00:00Z")).toBe(720);
  });

  it("full-day service (24h) → 1440 minutes", () => {
    expect(calcTimesheetDuration("2024-01-15T00:00:00Z", "2024-01-16T00:00:00Z")).toBe(1440);
  });
});

// ─── calcAbsenceSummary ───────────────────────────────────────────────────────

const JAN = { start: "2024-01-01", end: "2024-01-31" };

describe("calcAbsenceSummary — no absences", () => {
  it("returns zeros when list is empty", () => {
    const r = calcAbsenceSummary([], JAN.start, JAN.end, 168, 8);
    expect(r).toEqual({ absenceDays: 0, injustifiedDays: 0, absenceHours: 0, absenceDeductions: 0 });
  });
});

describe("calcAbsenceSummary — justified absences (no deduction)", () => {
  const types = ["doenca_com_baixa", "doenca_sem_baixa", "pessoal_justificado", "ferias", "feriado", "formacao", "outro"];

  it.each(types)("type '%s' → 0 deductions for a 3-day absence", (type) => {
    const r = calcAbsenceSummary(
      [{ absence_type: type, starts_on: "2024-01-10", ends_on: "2024-01-12" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(3);
    expect(r.injustifiedDays).toBe(0);
    expect(r.absenceDeductions).toBe(0);
  });
});

describe("calcAbsenceSummary — unjustified absence", () => {
  it("1-day unjustified → deduction = dailyHours × rate", () => {
    // contractedHours=168, 168/22 = ~7.636h/day, rate=8 → ~61.09€
    const r = calcAbsenceSummary(
      [{ absence_type: "pessoal_injustificado", starts_on: "2024-01-10", ends_on: "2024-01-10" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.injustifiedDays).toBe(1);
    expect(r.absenceDeductions).toBeCloseTo((168 / 22) * 8, 1);
  });

  it("3-day unjustified → deduction × 3", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "pessoal_injustificado", starts_on: "2024-01-08", ends_on: "2024-01-10" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.injustifiedDays).toBe(3);
    expect(r.absenceDeductions).toBeCloseTo(3 * (168 / 22) * 8, 1);
  });
});

describe("calcAbsenceSummary — period overlap", () => {
  it("absence entirely before period → 0 days", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2023-12-25", ends_on: "2023-12-31" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(0);
  });

  it("absence entirely after period → 0 days", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2024-02-01", ends_on: "2024-02-05" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(0);
  });

  it("absence spanning period start → only January days count", () => {
    // Dec 28 – Jan 5: only Jan 1–5 = 5 days in January
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2023-12-28", ends_on: "2024-01-05" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(5);
  });

  it("absence spanning period end → only January days count", () => {
    // Jan 29 – Feb 3: only Jan 29–31 = 3 days in January
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2024-01-29", ends_on: "2024-02-03" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(3);
  });

  it("absence spanning entire month → 31 days", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2023-12-01", ends_on: "2024-02-29" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(31);
  });

  it("single-day absence on Jan 1 → 1 day", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "doenca_sem_baixa", starts_on: "2024-01-01", ends_on: "2024-01-01" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(1);
  });

  it("single-day absence on Jan 31 → 1 day", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "doenca_sem_baixa", starts_on: "2024-01-31", ends_on: "2024-01-31" }],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(1);
  });
});

describe("calcAbsenceSummary — multiple absences", () => {
  it("two non-overlapping absences sum correctly", () => {
    const r = calcAbsenceSummary(
      [
        { absence_type: "doenca_sem_baixa", starts_on: "2024-01-05", ends_on: "2024-01-06" },
        { absence_type: "pessoal_injustificado", starts_on: "2024-01-15", ends_on: "2024-01-15" },
      ],
      JAN.start, JAN.end, 168, 8,
    );
    expect(r.absenceDays).toBe(3);
    expect(r.injustifiedDays).toBe(1);
  });

  it("absenceHours = absenceDays × (contractedHours / 22)", () => {
    const r = calcAbsenceSummary(
      [{ absence_type: "ferias", starts_on: "2024-01-08", ends_on: "2024-01-09" }],
      JAN.start, JAN.end, 160, 8,
    );
    expect(r.absenceHours).toBeCloseTo(2 * (160 / 22), 1);
  });
});

// ─── calcCollaboratorPayroll ──────────────────────────────────────────────────

const { start: JAN_START, end: JAN_END } = monthRange(2024, 1);

function ts(date: string, minutes: number): import("@/lib/payroll-calc").TimesheetEntry {
  return { duration_minutes: minutes, clock_in_at: `${date}T08:00:00Z` };
}

describe("calcCollaboratorPayroll — standard month", () => {
  it("160h worked, 20 days (8h each), no overtime, no absences → correct gross + net", () => {
    // 20 days × 480 min = 9600 min = exactly 160h — no rounding loss
    const timesheets = Array.from({ length: 20 }, (_, i) =>
      ts(`2024-01-${String(i + 1).padStart(2, "0")}`, 480),
    );
    const r = calcCollaboratorPayroll(timesheets, [], 160, 8, STD, JAN_START, JAN_END);

    expect(r.daysWorked).toBe(20);
    expect(r.workedHours).toBe(160);
    expect(r.overtimeHours).toBe(0);
    expect(r.grossSalary).toBe(1280);      // 160 × 8
    expect(r.mealAllowance).toBeCloseTo(20 * 9.6, 2); // 192
    expect(r.overtimeBonus).toBe(0);
    expect(r.absenceDeductions).toBe(0);
  });

  it("net salary = gross + meal + bonus − deductions", () => {
    const timesheets = [ts("2024-01-02", 480), ts("2024-01-03", 480)];
    const r = calcCollaboratorPayroll(timesheets, [], 160, 8, STD, JAN_START, JAN_END);
    const expected = r.grossSalary + r.mealAllowance + r.overtimeBonus + 0 - r.absenceDeductions - 0;
    expect(r.netSalary).toBeCloseTo(expected, 2);
  });

  it("zero timesheets → zero gross and zero net (no bonuses)", () => {
    const r = calcCollaboratorPayroll([], [], 160, 8, STD, JAN_START, JAN_END);
    expect(r.workedHours).toBe(0);
    expect(r.grossSalary).toBe(0);
    expect(r.daysWorked).toBe(0);
    expect(r.mealAllowance).toBe(0);
    expect(r.netSalary).toBe(0);
  });
});

describe("calcCollaboratorPayroll — overtime", () => {
  it("180h worked, 160h contracted → 20h overtime bonus", () => {
    const timesheets = Array.from({ length: 22 }, (_, i) =>
      ts(`2024-01-${String(i + 1).padStart(2, "0")}`, Math.round((180 / 22) * 60)),
    );
    const r = calcCollaboratorPayroll(timesheets, [], 160, 8, STD, JAN_START, JAN_END);
    expect(r.overtimeHours).toBeGreaterThan(0);
    expect(r.overtimeBonus).toBeCloseTo(r.overtimeHours * 8 * 0.25, 1);
  });

  it("workedHours < contractedHours → overtimeHours is exactly 0", () => {
    const r = calcCollaboratorPayroll([ts("2024-01-02", 240)], [], 160, 8, STD, JAN_START, JAN_END);
    expect(r.overtimeHours).toBe(0);
  });
});

describe("calcCollaboratorPayroll — with absences", () => {
  it("1 unjustified absence day → deduction applied", () => {
    const absence: import("@/lib/payroll-calc").AbsenceInput[] = [
      { absence_type: "pessoal_injustificado", starts_on: "2024-01-10", ends_on: "2024-01-10" },
    ];
    const r = calcCollaboratorPayroll([], absence, 160, 8, STD, JAN_START, JAN_END);
    expect(r.absenceDeductions).toBeGreaterThan(0);
    expect(r.injustifiedDays).toBe(1);
  });

  it("justified absence → no deduction but absenceDays counted", () => {
    const absence: import("@/lib/payroll-calc").AbsenceInput[] = [
      { absence_type: "doenca_com_baixa", starts_on: "2024-01-08", ends_on: "2024-01-12" },
    ];
    const r = calcCollaboratorPayroll([], absence, 160, 8, STD, JAN_START, JAN_END);
    expect(r.absenceDays).toBe(5);
    expect(r.absenceDeductions).toBe(0);
  });
});

describe("calcCollaboratorPayroll — extra additions/deductions", () => {
  it("other_additions add to net salary", () => {
    const r1 = calcCollaboratorPayroll([ts("2024-01-02", 480)], [], 160, 8, STD, JAN_START, JAN_END);
    const r2 = calcCollaboratorPayroll([ts("2024-01-02", 480)], [], 160, 8, STD, JAN_START, JAN_END, 100, 0);
    expect(r2.netSalary - r1.netSalary).toBeCloseTo(100, 2);
  });

  it("other_deductions reduce net salary", () => {
    const r1 = calcCollaboratorPayroll([ts("2024-01-02", 480)], [], 160, 8, STD, JAN_START, JAN_END);
    const r2 = calcCollaboratorPayroll([ts("2024-01-02", 480)], [], 160, 8, STD, JAN_START, JAN_END, 0, 50);
    expect(r1.netSalary - r2.netSalary).toBeCloseTo(50, 2);
  });
});

describe("calcCollaboratorPayroll — duplicate days (multiple shifts same day)", () => {
  it("two entries on same day → daysWorked = 1 (no double meal)", () => {
    const timesheets = [
      ts("2024-01-02", 240),
      ts("2024-01-02", 120),
    ];
    const r = calcCollaboratorPayroll(timesheets, [], 160, 8, STD, JAN_START, JAN_END);
    expect(r.daysWorked).toBe(1);
    expect(r.mealAllowance).toBeCloseTo(9.6, 2);
  });
});

describe("calcCollaboratorPayroll — 35 collaborators simulation", () => {
  it("35 collaborators each with 160h → correct total gross", () => {
    let totalGross = 0;
    for (let i = 0; i < 35; i++) {
      const timesheets = Array.from({ length: 20 }, (_, d) =>
        ts(`2024-01-${String(d + 2).padStart(2, "0")}`, 480),
      );
      const r = calcCollaboratorPayroll(timesheets, [], 160, 8, STD, JAN_START, JAN_END);
      totalGross += r.grossSalary;
    }
    // 35 × (20 × 8h × 8€/h) = 35 × 1280 = 44800
    expect(totalGross).toBeCloseTo(44800, 0);
  });
});

// ─── calcAdjustedNetSalary ────────────────────────────────────────────────────

describe("calcAdjustedNetSalary", () => {
  it("all zeros → 0", () => {
    expect(calcAdjustedNetSalary(0, 0, 0, 0, 0, 0)).toBe(0);
  });

  it("simple sum: 1200 + 211.2 + 0 + 0 − 0 − 0 = 1411.20", () => {
    expect(calcAdjustedNetSalary(1200, 211.2, 0, 0, 0, 0)).toBeCloseTo(1411.2, 2);
  });

  it("deductions reduce net", () => {
    expect(calcAdjustedNetSalary(1000, 200, 50, 0, 30, 20)).toBeCloseTo(1200, 2);
  });

  it("rounds to 2 decimal places", () => {
    // 1/3 + 1/3 + 1/3 = 1.00 (not 0.9999...)
    const r = calcAdjustedNetSalary(1 / 3, 1 / 3, 1 / 3, 0, 0, 0);
    expect(r).toBe(parseFloat(r.toFixed(2)));
  });
});

// ─── normalisePastTimestamp ───────────────────────────────────────────────────

describe("normalisePastTimestamp", () => {
  it("valid past ISO string is returned as-is (rounded to ms)", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = normalisePastTimestamp(past);
    expect(result).toBe(past);
  });

  it("future timestamp beyond 60s slack → returns current time", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const before = Date.now();
    const result = normalisePastTimestamp(future);
    const after = Date.now();
    expect(new Date(result).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(result).getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("non-string → returns current time", () => {
    const before = Date.now();
    const result = normalisePastTimestamp(12345);
    expect(new Date(result).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("garbage string → returns current time", () => {
    const before = Date.now();
    const result = normalisePastTimestamp("not-a-date");
    expect(new Date(result).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("timestamp within 60s in the future (acceptable slack) → accepted", () => {
    const slightFuture = new Date(Date.now() + 30_000).toISOString();
    const result = normalisePastTimestamp(slightFuture);
    expect(result).toBe(slightFuture);
  });
});

// ─── parseCoord ───────────────────────────────────────────────────────────────

describe("parseCoord", () => {
  it("valid number string → number", () => {
    expect(parseCoord("38.7169")).toBe(38.7169);
  });

  it("numeric value → number", () => {
    expect(parseCoord(38.7169)).toBe(38.7169);
  });

  it("null → null", () => {
    expect(parseCoord(null)).toBeNull();
  });

  it("undefined → null", () => {
    expect(parseCoord(undefined)).toBeNull();
  });

  it("empty string → null", () => {
    expect(parseCoord("")).toBeNull();
  });

  it("NaN string → null", () => {
    expect(parseCoord("abc")).toBeNull();
  });

  it("0 is valid", () => {
    expect(parseCoord(0)).toBe(0);
  });

  it("negative coordinate is valid", () => {
    expect(parseCoord(-9.1399)).toBe(-9.1399);
  });
});
