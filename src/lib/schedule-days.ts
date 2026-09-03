import type { ScheduleDay } from "@/types/database";

// Comparação semântica de `contracts.schedule_days`.
//
// A coluna é JSONB. O Postgres guarda o objeto pela sua própria ordem interna
// de chaves e devolve-o assim — `{day, start_time, duration_min, team_id,
// num_people}` pode voltar como `{day, team_id, num_people, start_time,
// duration_min}`. O read-after-write de `updateContrato` comparava os dois
// lados com `JSON.stringify`, que é sensível à ordem das chaves: mesmo
// conteúdo, texto diferente, divergência falsa. O utilizador via
// "campos divergentes: schedule_days" numa gravação que tinha corrido bem.
//
// A ordem das CHAVES de cada objeto não pode importar. A ordem dos ELEMENTOS
// do array continua a importar: `schedule_days[0]` é o padrão usado quando o
// dia da semana do serviço não tem entrada própria
// (`updateFutureServiceValuesForContract`), logo trocar a ordem dos dias muda
// comportamento. Por isso não se ordena o array.

/** Campos que definem um dia do padrão. Nada fora daqui é normalizado. */
export const SCHEDULE_DAY_FIELDS = [
  "day", "start_time", "duration_min", "team_id", "num_people",
] as const;

export type NormalizedScheduleDay = {
  day: string;
  start_time: string;
  duration_min: number | null;
  team_id: string | null;
  num_people: number | null;
  /** Chaves fora do conjunto canónico, preservadas para não passarem em claro. */
  extra: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Põe os dois lados na mesma forma. Devolve `null` quando o valor não é um
 * array — "ausente" e "com outra forma" não são a mesma coisa que uma lista.
 */
export function normalizeScheduleDays(value: unknown): NormalizedScheduleDay[] | null {
  if (!Array.isArray(value)) return null;

  return value.map((raw) => {
    const item = asRecord(raw);
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(item)) {
      if (!(SCHEDULE_DAY_FIELDS as readonly string[]).includes(key)) extra[key] = item[key];
    }
    return {
      day: String(item.day ?? ""),
      start_time: String(item.start_time ?? ""),
      duration_min: num(item.duration_min),
      team_id: str(item.team_id),
      num_people: num(item.num_people),
      extra,
    };
  });
}

/**
 * Duas chaves fora do conjunto canónico só são iguais se existirem dos dois
 * lados com o mesmo valor. Um campo que apareça do nada (trigger, default) é
 * divergência a sério e não pode ser engolido por não estar na lista.
 */
function extraEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Igualdade semântica entre o padrão enviado e o padrão gravado.
 *
 * `Object.is` em vez de `===` para que dois `NaN` (um `duration_min` que os
 * dois lados trazem inutilizável) contem como iguais em vez de fabricarem uma
 * divergência que ninguém consegue resolver na interface.
 */
export function scheduleDaysEqual(left: unknown, right: unknown): boolean {
  // Ausente dos dois lados é igual — um contrato sem padrão gravado não pode
  // ficar impedido de guardar por causa da confirmação.
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing || rightMissing) return leftMissing && rightMissing;

  const a = normalizeScheduleDays(left);
  const b = normalizeScheduleDays(right);
  // Forma inesperada de um dos lados: fail-closed, não se declara igual.
  if (a === null || b === null || a.length !== b.length) return false;

  return a.every((item, index) => {
    const other = b[index];
    return item.day === other.day &&
      item.start_time === other.start_time &&
      Object.is(item.duration_min, other.duration_min) &&
      item.team_id === other.team_id &&
      Object.is(item.num_people, other.num_people) &&
      extraEqual(item.extra, other.extra);
  });
}

/** Só para quem precisa do tipo do domínio; a comparação aceita `unknown`. */
export type ScheduleDayLike = ScheduleDay | Record<string, unknown>;
