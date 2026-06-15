// Pure calculation functions — no Supabase, no Next.js, no side effects.
// Extracted from server actions so they can be unit-tested without a DB.

// ─── Month range ──────────────────────────────────────────────────────────────

export function monthRange(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, "0");
  const start = `${year}-${mm}-01`;
  // Date.UTC avoids local-timezone offset shifting the day on non-UTC hosts.
  const end = new Date(Date.UTC(year, month, 0)).toISOString().split("T")[0];
  return { start, end };
}

// ─── Timesheet duration ───────────────────────────────────────────────────────

/**
 * Duration in minutes between clock-in and clock-out.
 * Returns null if the result would be negative (invalid pair).
 */
export function calcTimesheetDuration(
  clockInAt: string,
  clockOutAt: string,
): number | null {
  const diff = new Date(clockOutAt).getTime() - new Date(clockInAt).getTime();
  if (diff < 0) return null;
  return Math.round(diff / 60_000);
}

// ─── Absence summary ──────────────────────────────────────────────────────────

export interface AbsenceInput {
  absence_type: string;
  starts_on: string; // YYYY-MM-DD
  ends_on: string;   // YYYY-MM-DD
}

export interface AbsenceSummary {
  absenceDays: number;
  injustifiedDays: number;
  absenceHours: number;
  absenceDeductions: number;
}

export function calcAbsenceSummary(
  absences: AbsenceInput[],
  periodStart: string,
  periodEnd: string,
  contractedHours: number,
  hourlyRate: number,
): AbsenceSummary {
  let absenceDays = 0;
  let injustifiedDays = 0;

  for (const a of absences) {
    // Clamp to period
    const aStart = new Date(
      Math.max(new Date(a.starts_on).getTime(), new Date(periodStart).getTime()),
    );
    const aEnd = new Date(
      Math.min(new Date(a.ends_on).getTime(), new Date(periodEnd).getTime()),
    );
    const days =
      Math.round((aEnd.getTime() - aStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (days > 0) {
      absenceDays += days;
      if (a.absence_type === "pessoal_injustificado") injustifiedDays += days;
    }
  }

  const dailyHours = contractedHours / 22;
  const absenceHours = Math.round(absenceDays * dailyHours * 100) / 100;
  const absenceDeductions =
    Math.round(injustifiedDays * dailyHours * hourlyRate * 100) / 100;

  return { absenceDays, injustifiedDays, absenceHours, absenceDeductions };
}

// ─── Collaborator payroll ─────────────────────────────────────────────────────

export interface TimesheetEntry {
  duration_minutes: number;
  clock_in_at: string; // ISO timestamp
}

export interface PayrollSettings {
  defaultHourlyRate: number;
  mealAllowanceDay: number;
  overtimeRatePct: number;
}

export interface CollaboratorPayrollResult {
  workedHours: number;
  daysWorked: number;
  overtimeHours: number;
  grossSalary: number;
  mealAllowance: number;
  overtimeBonus: number;
  absenceDays: number;
  injustifiedDays: number;
  absenceHours: number;
  absenceDeductions: number;
  netSalary: number;
}

export function calcCollaboratorPayroll(
  timesheets: TimesheetEntry[],
  absences: AbsenceInput[],
  contractedHours: number,
  hourlyRate: number,
  settings: PayrollSettings,
  periodStart: string,
  periodEnd: string,
  otherAdditions = 0,
  otherDeductions = 0,
): CollaboratorPayrollResult {
  // Worked hours from timesheets
  const workedMinutes = timesheets.reduce(
    (s, t) => s + Math.max(0, t.duration_minutes ?? 0),
    0,
  );
  const workedHours = Math.round((workedMinutes / 60) * 100) / 100;

  // Unique worked days (by date prefix of ISO clock_in_at)
  const datesSet = new Set(
    timesheets.filter((t) => t.clock_in_at).map((t) => t.clock_in_at.slice(0, 10)),
  );
  const daysWorked = datesSet.size;

  // Overtime: hours above contracted
  const overtimeHours = Math.max(
    0,
    Math.round((workedHours - contractedHours) * 100) / 100,
  );

  // Absence calculations
  const { absenceDays, injustifiedDays, absenceHours, absenceDeductions } =
    calcAbsenceSummary(absences, periodStart, periodEnd, contractedHours, hourlyRate);

  // Monetary values
  const grossSalary = Math.round(workedHours * hourlyRate * 100) / 100;
  const mealAllowance = Math.round(daysWorked * settings.mealAllowanceDay * 100) / 100;
  const overtimeBonus =
    Math.round(overtimeHours * hourlyRate * (settings.overtimeRatePct / 100) * 100) / 100;

  const netSalary =
    Math.round(
      (grossSalary +
        mealAllowance +
        overtimeBonus +
        otherAdditions -
        absenceDeductions -
        otherDeductions) *
        100,
    ) / 100;

  return {
    workedHours,
    daysWorked,
    overtimeHours,
    grossSalary,
    mealAllowance,
    overtimeBonus,
    absenceDays,
    injustifiedDays,
    absenceHours,
    absenceDeductions,
    netSalary,
  };
}

// ─── Adjusted net salary (for manual payroll adjustments) ────────────────────

export function calcAdjustedNetSalary(
  grossSalary: number,
  mealAllowance: number,
  overtimeBonus: number,
  otherAdditions: number,
  absenceDeductions: number,
  otherDeductions: number,
): number {
  return (
    Math.round(
      (grossSalary +
        mealAllowance +
        overtimeBonus +
        otherAdditions -
        absenceDeductions -
        otherDeductions) *
        100,
    ) / 100
  );
}

// ─── Timestamp validation (mirrors API route logic) ──────────────────────────

/**
 * Accept an offline-queued timestamp only if it is in the past (with 60s slack).
 * Returns the original ISO string if valid, or current time if not.
 */
export function normalisePastTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t <= Date.now() + 60_000) {
      return new Date(t).toISOString();
    }
  }
  return new Date().toISOString();
}

// ─── GPS coordinate parsing (mirrors API route logic) ────────────────────────

export function parseCoord(value: unknown): number | null {
  // Explicitly reject null/undefined/empty so they aren't coerced to 0 by Number().
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
