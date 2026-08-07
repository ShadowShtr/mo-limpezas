// Data civil ("YYYY-MM-DD") — dia de calendário, sem hora e sem fuso.
//
// Uma ocorrência de contrato é uma DATA OPERACIONAL ("o serviço é no dia 17"),
// não um instante. Representá-la como `Date` obriga a escolher uma hora e um
// fuso, e foi exatamente daí que vieram os desvios de ±1 dia do projeto:
// `new Date("2026-07-17T00:00:00")` é meia-noite LOCAL, e `.toISOString()`
// devolve-a em UTC — em Lisboa no verão (UTC+1) isso é o dia 16.
//
// Aqui a aritmética é toda feita em `Date.UTC`, onde não existe horário de
// verão: somar 7 dias é sempre somar 7 × 24 h. O `Date` só volta a aparecer na
// fronteira, quando um consumidor precisa mesmo dele.
//
// Nota útil: em "YYYY-MM-DD" a ordem lexicográfica é igual à ordem
// cronológica, por isso comparar datas com `<`, `>` e `===` sobre a string é
// correto e é o que este módulo faz.

export type CivilDate = string; // "YYYY-MM-DD"

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Valida estritamente. Rejeita o que o `Date` aceitaria por rollover
 * silencioso — "2026-02-30" (não existe) e "72026-01-01" (o ano com um dígito
 * a mais que já corrompeu contratos reais em produção).
 */
export function isValidCivilDate(value: unknown): value is CivilDate {
  if (typeof value !== "string" || !CIVIL_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** Número de dias do mês (`month` é 1–12). Trata anos bissextos. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Partes numéricas de uma data civil já validada. */
export function partsOf(date: CivilDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

/**
 * Constrói uma data civil a partir das partes, limitando o dia ao último dia
 * do mês. É o `clamp` que evita o rollover de `new Date(2026, 1, 31)`, que
 * salta silenciosamente para março.
 */
export function civilDate(year: number, month: number, day: number): CivilDate {
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** Dias inteiros desde a época, em UTC — imune a horário de verão. */
export function toEpochDay(date: CivilDate): number {
  const { year, month, day } = partsOf(date);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/** Inverso de `toEpochDay`. */
export function fromEpochDay(epochDay: number): CivilDate {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Soma dias de calendário (aceita negativos). */
export function addDays(date: CivilDate, days: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Dias civis de `from` até `to` (negativo se `to` for anterior). */
export function daysBetween(from: CivilDate, to: CivilDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Dia da semana: 0 = domingo … 6 = sábado (igual a `Date.prototype.getDay`). */
export function dayOfWeek(date: CivilDate): number {
  // 1970-01-01 (epoch day 0) foi uma quinta-feira → +4.
  return (((toEpochDay(date) + 4) % 7) + 7) % 7;
}

export function isWeekend(date: CivilDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** Segunda-feira da semana civil da data (semana começa à segunda). */
export function startOfWeek(date: CivilDate): CivilDate {
  const dow = dayOfWeek(date);
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return addDays(date, -backToMonday);
}

/** Primeiro dia do mês. */
export function startOfMonth(date: CivilDate): CivilDate {
  const { year, month } = partsOf(date);
  return civilDate(year, month, 1);
}

/** Soma meses ao mês da data, devolvendo o dia 1 do mês resultante. */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const { year, month } = partsOf(date);
  const total = year * 12 + (month - 1) + months;
  return civilDate(Math.floor(total / 12), (total % 12) + 1, 1);
}

/**
 * Converte para `Date` à meia-noite LOCAL — a representação que os
 * consumidores antigos (calendário, formulários) já esperam. Deve ser usado
 * só na fronteira, nunca dentro do domínio.
 */
export function toLocalDate(date: CivilDate): Date {
  const { year, month, day } = partsOf(date);
  return new Date(year, month - 1, day);
}

/**
 * Lê a data civil de um `Date` pelos seus campos LOCAIS. É o inverso exato de
 * `toLocalDate` e substitui `.toISOString().slice(0, 10)`, que troca o dia
 * sempre que o fuso do processo não é UTC.
 */
export function fromLocalDate(value: Date): CivilDate {
  return civilDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
}
