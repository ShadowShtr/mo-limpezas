export const STANDARD_ANNUAL_VACATION_DAYS = 22;
export const ADMISSION_YEAR_DAYS_PER_MONTH = 2;
export const ADMISSION_YEAR_MAX_DAYS = 20;
export const ADMISSION_YEAR_MIN_MONTHS = 6;

/**
 * Dias úteis de férias a que um colaborador tem direito num dado ano civil,
 * segundo o Código do Trabalho (art. 238.º/239.º):
 * - No ano de admissão: 2 dias úteis por cada mês completo de contrato
 *   (só conta a partir de 6 meses completos), até ao máximo de 20 dias.
 * - A partir do ano civil seguinte ao da admissão: os 22 dias normais,
 *   independentemente do dia/mês exato de admissão (regime de ano civil,
 *   não de aniversário de contrato).
 */
export function calcVacationEntitlement(contractStart: string, year: number): number {
  const start = new Date(contractStart + "T00:00:00");
  const hireYear = start.getFullYear();

  if (year < hireYear) return 0;
  if (year > hireYear) return STANDARD_ANNUAL_VACATION_DAYS;

  const yearEnd = new Date(year, 11, 31);
  let months = (yearEnd.getFullYear() - start.getFullYear()) * 12 + (yearEnd.getMonth() - start.getMonth());
  if (yearEnd.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);

  if (months < ADMISSION_YEAR_MIN_MONTHS) return 0;
  return Math.min(ADMISSION_YEAR_MAX_DAYS, months * ADMISSION_YEAR_DAYS_PER_MONTH);
}
