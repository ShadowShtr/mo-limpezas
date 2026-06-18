// Cálculos puros do Registo de Ponto — sem Supabase nem Next.js, testáveis isoladamente.
// Convenção de mês de trabalho: 22 dias úteis (alinhado com payroll-calc).

const WORK_DAYS_PER_MONTH = 22;

/** Minutos contratados por dia, a partir das horas contratadas mensais. */
export function dailyContractedMinutes(contractedHoursMonth: number | null | undefined): number {
  if (!contractedHoursMonth || contractedHoursMonth <= 0) return 0;
  return Math.round((contractedHoursMonth / WORK_DAYS_PER_MONTH) * 60);
}

export interface TimesheetLike {
  clock_in_at: string | null;
  clock_out_at: string | null;
  duration_minutes: number | null;
}

/**
 * Minutos trabalhados a partir dos registos de ponto.
 * Para pontos em curso (entrada sem saída) conta o tempo decorrido até `nowMs`.
 */
export function timesheetWorkedMinutes(rows: TimesheetLike[], nowMs: number): number {
  let total = 0;
  for (const t of rows) {
    if (t.duration_minutes != null) {
      total += Math.max(0, t.duration_minutes);
    } else if (t.clock_in_at && !t.clock_out_at) {
      const elapsed = Math.round((nowMs - new Date(t.clock_in_at).getTime()) / 60_000);
      total += Math.max(0, elapsed);
    }
  }
  return total;
}

/** Há um ponto aberto (entrada sem saída)? */
export function hasOpenTimesheet(rows: TimesheetLike[]): boolean {
  return rows.some((t) => t.clock_in_at && !t.clock_out_at);
}

export interface AbsenceLike {
  starts_on: string; // YYYY-MM-DD
  ends_on: string;   // YYYY-MM-DD
}

/** A data (YYYY-MM-DD) está coberta por alguma ausência? */
export function isAbsentOn(absences: AbsenceLike[], dateISO: string): boolean {
  return absences.some((a) => dateISO >= a.starts_on && dateISO <= a.ends_on);
}

/** Saldo (minutos) = trabalhado − contratado. Negativo = défice. */
export function balanceMinutes(workedMin: number, contractedMin: number): number {
  return workedMin - contractedMin;
}

/** Formata minutos como "HH:MM" (sempre positivo). Aceita sinal opcional. */
export function formatHM(minutes: number, withSign = false): string {
  const sign = minutes < 0 ? "-" : withSign ? "+" : "";
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
