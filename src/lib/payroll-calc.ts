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

// ─── Overtime bonus ───────────────────────────────────────────────────────────

/**
 * Acréscimo pago pelas horas para além do período contratado.
 *
 * 🔴 Fonte **única** desta regra. Até à blindagem da folha existiam duas: esta,
 *    parametrizada por `overtime_rate_pct` das definições da empresa, e um
 *    `* 0.25` escrito à mão dentro de `adjustPayrollRecord`. Configurar 50% nas
 *    definições mudava o cálculo mensal e não mudava o ajuste manual — a mesma
 *    colaboradora, no mesmo mês, tinha dois valores de hora extra consoante o
 *    caminho por onde o número tinha passado.
 *
 * Quem chamar isto passa a percentagem que leu; não a inventa.
 */
export function calcOvertimeBonus(
  overtimeHours: number,
  hourlyRate: number,
  overtimeRatePct: number,
): number {
  return Math.round(overtimeHours * hourlyRate * (overtimeRatePct / 100) * 100) / 100;
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
  /**
   * Vencimento base mensal da empresa — o que vale para quem não tem o seu
   * próprio. Tipicamente o salário mínimo.
   */
  defaultBaseSalaryMonthly?: number;
}

export interface CollaboratorPayrollResult {
  workedHours: number;
  daysWorked: number;
  overtimeHours: number;
  /** Vencimento base do mês. É a base do bruto quando existe. */
  baseSalary: number;
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
  /**
   * Vencimento base desta pessoa. `null`/`undefined` cai no da empresa; zero
   * ou ausência dos dois mantém o modelo antigo (bruto = horas × taxa).
   */
  baseSalaryMonthly?: number | null,
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

  // ── O bruto ───────────────────────────────────────────────────────────────
  //
  // 🔴 Aqui estava, e só estava, `workedHours × hourlyRate`. Não havia
  //    vencimento base em lado nenhum, por isso quem é contratado ao salário
  //    mínimo só lá chegava por acaso — se as horas do ponto vezes a taxa
  //    dessem esse número. Não davam: a leitura de produção mostra
  //    `hourly_rate` entre 5,23 € e 9,50 €, sinal de que a taxa horária andou
  //    a ser torcida para o total bater certo. Um campo a fazer o trabalho de
  //    outro.
  //
  //    Com vencimento base, o bruto é o base. As horas continuam a ser
  //    contadas e gravadas, mas passam a ser assiduidade — e as horas ACIMA
  //    das contratadas continuam a pagar-se como extra, por cima.
  //
  //    Sem base definido (nem na pessoa nem na empresa), o cálculo antigo
  //    mantém-se tal e qual. Ninguém é obrigado a migrar de modelo por esta
  //    alteração existir.
  const baseSalary = resolveBaseSalary(baseSalaryMonthly, settings.defaultBaseSalaryMonthly);
  const grossSalary = baseSalary > 0
    ? baseSalary
    : Math.round(workedHours * hourlyRate * 100) / 100;

  const mealAllowance = Math.round(daysWorked * settings.mealAllowanceDay * 100) / 100;
  const overtimeBonus = calcOvertimeBonus(overtimeHours, hourlyRate, settings.overtimeRatePct);

  // Uma soma só: a mesma que o ajuste manual usa. Ver `calcAdjustedNetSalary`.
  const netSalary = calcAdjustedNetSalary(
    grossSalary,
    mealAllowance,
    overtimeBonus,
    otherAdditions,
    absenceDeductions,
    otherDeductions,
  );

  return {
    workedHours,
    daysWorked,
    overtimeHours,
    baseSalary,
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

/**
 * Qual vencimento base vale: o da pessoa, o da empresa, ou nenhum.
 *
 * 🔴 `0` da pessoa NÃO cai no da empresa. Zero é uma resposta — «esta pessoa
 *    não tem vencimento base, paga-se-lhe às horas» — e tratá-lo como ausência
 *    daria à pessoa um base que ninguém lhe atribuiu. Só `null`/`undefined`,
 *    que são ausência a sério, procuram o da empresa.
 *
 * Valores inválidos (NaN, infinito, negativo) não passam: um base corrompido
 * escreveria um salário errado em vez de falhar à vista.
 */
export function resolveBaseSalary(
  daPessoa: number | null | undefined,
  daEmpresa: number | null | undefined,
): number {
  const valido = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;

  if (daPessoa !== null && daPessoa !== undefined) {
    return valido(daPessoa) ? Math.round(daPessoa * 100) / 100 : 0;
  }
  return valido(daEmpresa) ? Math.round(daEmpresa * 100) / 100 : 0;
}

// ─── Adjusted net salary (for manual payroll adjustments) ────────────────────

export function calcAdjustedNetSalary(
  grossSalary: number,
  mealAllowance: number,
  overtimeBonus: number,
  otherAdditions: number,
  absenceDeductions: number,
  otherDeductions: number,
  /**
   * Dias extras (sábados, feriados) já convertidos em euros, e adiantamento
   * já entregue.
   *
   * 🔴 Entram como parâmetros com valor por omissão, e não como campos novos
   *    obrigatórios: todos os chamadores antigos continuam a somar o mesmo
   *    que somavam. Quem não usa dias extras nem adiantamentos não vê
   *    diferença nenhuma no total.
   */
  extraDaysBonus = 0,
  advanceDeduction = 0,
): number {
  return (
    Math.round(
      (grossSalary +
        mealAllowance +
        overtimeBonus +
        extraDaysBonus +
        otherAdditions -
        absenceDeductions -
        advanceDeduction -
        otherDeductions) *
        100,
    ) / 100
  );
}

/**
 * O bónus das horas extra.
 *
 * Duas formas, e a escolha não é arbitrária:
 *
 *   · com `€/hora extra` definido, é `horas × valor`. É o que uma empresa que
 *     paga o bruto sabe de cor, e não depende de uma taxa horária que aqui é
 *     ficção — o ponto está vazio, a taxa foi torcida para os totais baterem,
 *     e multiplicar uma percentagem por cima disso agrava o erro;
 *
 *   · sem ele, mantém-se `horas × taxa × percentagem`, para quem já usava
 *     assim.
 */
export function calcOvertimeValue(
  overtimeHours: number,
  hourlyRate: number,
  overtimeRatePct: number,
  overtimeHourRate?: number | null,
): number {
  const valido = typeof overtimeHourRate === "number"
    && Number.isFinite(overtimeHourRate)
    && overtimeHourRate > 0;

  if (valido) {
    return Math.round(overtimeHours * (overtimeHourRate as number) * 100) / 100;
  }
  return calcOvertimeBonus(overtimeHours, hourlyRate, overtimeRatePct);
}

/**
 * Dias extras trabalhados × valor de cada um.
 *
 * Um sábado não é «horas extra»: é um dia, com um preço combinado. Sem este
 * conceito, quem quisesse pagá-lo tinha de o esconder dentro de «acréscimos»
 * — e o recibo deixava de dizer o que aquele dinheiro era.
 */
export function calcExtraDaysBonus(extraDays: number, extraDayRate: number): number {
  if (!Number.isFinite(extraDays) || !Number.isFinite(extraDayRate)) return 0;
  if (extraDays <= 0 || extraDayRate <= 0) return 0;
  return Math.round(extraDays * extraDayRate * 100) / 100;
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
