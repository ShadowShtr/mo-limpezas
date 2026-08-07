// Algoritmo de recorrência ANTERIOR à Task T07, congelado.
//
// Não é código de produção e NUNCA deve ser chamado pela aplicação. Existe por
// uma razão só: medir o impacto da mudança do motor sobre contratos que já
// existem. Sem isto, o risco de compatibilidade da T07 fica qualitativo
// ("a paridade pode mudar") em vez de mensurável ("mudam estes contratos").
//
// ── Porque é que a paridade pode mudar ──────────────────────────────────────
//
// O algoritmo antigo agrupava semanas com `floor(timestamp / 7 dias)`. Essa
// divisão conta a partir da época Unix, e 1970-01-01 foi uma QUINTA-FEIRA —
// logo a fronteira entre "baldes" de semana caía à quinta-feira, não à
// segunda. O motor canónico conta semanas civis desde a segunda-feira da
// semana em que o contrato começa.
//
// Consequência: um contrato quinzenal cuja semana de início atravesse essa
// fronteira pode mudar de paridade **sem envolver horário de verão nenhum**.
// O DST é uma segunda causa, independente desta.
//
// ── Fuso assumido ───────────────────────────────────────────────────────────
//
// O original construía `Date` com o construtor LOCAL. Em produção (Vercel) o
// processo corre em UTC, por isso esta reprodução usa `Date.UTC`: modela o
// comportamento realmente observado em produção e mantém-se determinística
// independentemente do fuso da máquina que corre a comparação.

import {
  addDays,
  civilDate,
  dayOfWeek,
  daysInMonth,
  isValidCivilDate,
  isWeekend,
  partsOf,
  toEpochDay,
  type CivilDate,
} from "./civil-date";
import type { CivilRange, RecurrenceRule } from "./recurrence-engine";

const CADENCE_WEEKS: Record<string, number> = { weekly: 1, biweekly: 2, triweekly: 3 };

/** Desvio de fim de semana do algoritmo antigo (idêntico ao atual). */
function legacyShift(date: CivilDate): CivilDate {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, 2);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/**
 * Balde de semana do algoritmo antigo: `floor(timestamp / (7 dias))`.
 *
 * Em dias inteiros é `floor(epochDay / 7)`, cuja fronteira cai à quinta-feira.
 * É esta fronteira herdada da época que o motor canónico substituiu.
 */
function legacyWeekBucket(date: CivilDate): number {
  return Math.floor(toEpochDay(date) / 7);
}

/**
 * O dia do mês do antigo `monthly` vinha de `new Date(ano, mês, dia)`, que
 * TRANSBORDA quando o mês não tem esse dia (31 de fevereiro → 3 de março).
 */
function legacyMonthlyBase(year: number, month: number, anchorDay: number): CivilDate {
  const overflow = anchorDay - daysInMonth(year, month);
  if (overflow <= 0) return civilDate(year, month, anchorDay);
  // Transborda para o mês seguinte, exatamente como o `Date` fazia.
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return addDays(civilDate(nextMonth.year, nextMonth.month, 1), overflow - 1);
}

/**
 * Ocorrências segundo o algoritmo anterior à T07.
 *
 * Reproduz o comportamento tal como era, defeitos incluídos — o mensal só no
 * mês de `range.start`, o transbordo do dia 31 e os baldes de semana da época.
 * Corrigir aqui destruiria a única prova de impacto que temos.
 */
export function legacyOccurrencesInRange(rule: RecurrenceRule, range: CivilRange): CivilDate[] {
  if (!isValidCivilDate(rule.startsOn)) return [];
  if (!isValidCivilDate(range.start) || !isValidCivilDate(range.end)) return [];
  if (range.end < range.start) return [];

  const startsOn = rule.startsOn;
  // O antigo fazia `new Date(ends_on + "T23:59:59")`; uma data inválida dava
  // `Invalid Date` e todas as comparações falhavam — nenhuma ocorrência.
  const endsOn = rule.endsOn ?? null;
  if (endsOn !== null && !isValidCivilDate(endsOn)) return [];
  const excluded = new Set(rule.excludedDates ?? []);

  function inRangeShiftable(d: CivilDate): boolean {
    return d >= range.start && d >= startsOn
      && (!endsOn || d <= endsOn) && !excluded.has(d);
  }
  function inRange(d: CivilDate): boolean {
    return d <= range.end && inRangeShiftable(d);
  }

  const results: CivilDate[] = [];
  const frequency = rule.frequency;

  if (frequency === "daily") {
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
      if (!isWeekend(d) && inRange(d)) results.push(d);
    }
  } else if (Object.hasOwn(CADENCE_WEEKS, frequency)) {
    const cadence = CADENCE_WEEKS[frequency];
    const weekdays = rule.weekdays ?? [];
    const startBucket = legacyWeekBucket(startsOn);
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
      if (!weekdays.includes(dayOfWeek(d))) continue;
      const correctWeek = cadence === 1 || (legacyWeekBucket(d) - startBucket) % cadence === 0;
      if (correctWeek && inRange(d)) results.push(d);
    }
  } else if (frequency === "monthly") {
    // Só o mês de `range.start` — a razão pela qual um intervalo de seis meses
    // devolvia uma única ocorrência.
    const { year, month } = partsOf(range.start);
    const anchorDay = partsOf(startsOn).day;
    const target = legacyShift(legacyMonthlyBase(year, month, anchorDay));
    if (inRangeShiftable(target)) results.push(target);
  } else if (frequency === "custom") {
    const step = Math.max(1, rule.intervalDays ?? 1);
    const used = new Set<CivilDate>();
    // Percorria SEMPRE desde o início do contrato — o problema de desempenho.
    for (let base = startsOn; base <= range.end; base = addDays(base, step)) {
      const shifted = legacyShift(base);
      if (inRangeShiftable(shifted) && !used.has(shifted)) {
        used.add(shifted);
        results.push(shifted);
      }
    }
  }

  return results;
}
