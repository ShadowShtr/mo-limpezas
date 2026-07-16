import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format as dateFnsFormat, parseISO } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formata uma data (string ISO ou Date) com date-fns sem nunca lançar.
 * date-fns `format()` lança RangeError para uma Invalid Date (ex.: um
 * `starts_on` de contrato corrompido) — isso rebenta a página inteira em vez
 * de mostrar só um "—". Usar em qualquer sítio onde a data venha de dados
 * gravados por um utilizador (contratos, ausências), não de timestamps
 * sempre gerados pelo servidor.
 */
/**
 * Valida uma data "YYYY-MM-DD" (formato de <input type="date"> e das colunas
 * DATE da BD): 4 dígitos de ano dentro de um intervalo plausível, mês/dia
 * reais (rejeita "2026-02-30") e sem excesso de dígitos (rejeita
 * "72026-01-01" — o bug de um contrato gravado com ano corrompido).
 */
export function isValidIsoDateString(
  value: string,
  { minYear = 1900, maxYear = 2100 }: { minYear?: number; maxYear?: number } = {},
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < minYear || year > maxYear) return false;
  const date = parseISO(value);
  if (Number.isNaN(date.getTime())) return false;
  return dateFnsFormat(date, "yyyy-MM-dd") === value;
}

/**
 * Valida um número financeiro/quantidade vindo de um server action (hora,
 * preço, unidades, etc.): finito, não-negativo e sem excesso de magnitude.
 * `null`/`undefined` passam (campo opcional) — quem chama decide se o campo
 * é obrigatório antes de validar o valor.
 */
export function isValidFiniteNumber(
  value: number | null | undefined,
  { max = 1_000_000 }: { max?: number } = {},
): boolean {
  if (value === null || value === undefined) return true;
  return Number.isFinite(value) && value >= 0 && value <= max;
}

export function safeFormat(
  value: string | Date | null | undefined,
  pattern: string,
  options?: Parameters<typeof dateFnsFormat>[2],
  fallback = "—",
): string {
  if (!value) return fallback;
  try {
    const date = typeof value === "string" ? parseISO(value) : value;
    if (Number.isNaN(date.getTime())) return fallback;
    return dateFnsFormat(date, pattern, options);
  } catch {
    return fallback;
  }
}

export function formatDistanceToNow(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  return new Date(dateStr).toLocaleDateString("pt-PT", { day: "numeric", month: "short" });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long" });
}
