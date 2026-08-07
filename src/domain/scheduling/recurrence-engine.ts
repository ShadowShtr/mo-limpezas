// Motor canónico de recorrência (Task T07).
//
// ÚNICA fonte de verdade para "em que dias é que este contrato acontece".
// Antes desta consolidação existiam três implementações independentes — a
// geração real (`lib/contract-occurrences.ts`), o preview do formulário de
// contratos e a coluna "próxima ocorrência" da tabela — e as três davam
// respostas diferentes para o mesmo contrato.
//
// O motor é PURO: sem Supabase, sem fetch, sem cache, sem `process.env`, sem
// relógio. As mesmas entradas dão sempre exatamente a mesma saída, o que o
// torna validável offline.
//
// Trabalha em datas civis ("YYYY-MM-DD"), nunca em instantes — ver
// `./civil-date.ts` para a razão.

import {
  addDays,
  addMonths,
  civilDate,
  dayOfWeek,
  daysBetween,
  isValidCivilDate,
  isWeekend,
  partsOf,
  startOfMonth,
  startOfWeek,
  type CivilDate,
} from "./civil-date";

export type { CivilDate };

/** Cadência em semanas das frequências ancoradas num dia da semana. */
const CADENCE_WEEKS: Record<string, number> = { weekly: 1, biweekly: 2, triweekly: 3 };

// Política de fim de semana, por frequência:
//
// - `monthly` e `custom` EMPURRAM para a segunda seguinte. Nestas o dia é
//   arbitrário — calhou naquele número do mês, ou no fim de um intervalo de N
//   dias — e ninguém o escolheu de propósito.
// - `weekly`/`biweekly`/`triweekly` MANTÊM o dia. Foi escolhido à mão: empurrar
//   colidiria com outro dia já escolhido no mesmo contrato, e um contrato
//   marcado para sábado nunca mais aconteceria ao sábado.
// - `daily` SALTA o fim de semana ("diário" no produto é "todos os dias
//   úteis"); empurrar perderia o dia.

export interface RecurrenceRule {
  frequency: string;
  /** Dias da semana (0 = domingo … 6 = sábado). Só para weekly/biweekly/triweekly. */
  weekdays?: readonly number[] | null;
  /** Intervalo em dias. Só para `custom`. */
  intervalDays?: number | null;
  startsOn: string;
  endsOn?: string | null;
  /** Datas apagadas à mão do calendário — nunca são recriadas. */
  excludedDates?: readonly string[] | null;
}

export interface CivilRange {
  start: string;
  end: string;
}

/**
 * Fim de semana empurra para a segunda-feira seguinte.
 * Sábado +2, domingo +1, dia útil fica na mesma.
 */
export function shiftWeekendForward(date: CivilDate): CivilDate {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, 2);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** Módulo sempre positivo (o `%` do JS devolve negativo para entradas negativas). */
function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Datas em que o contrato acontece dentro do intervalo pedido.
 *
 * Saída sempre por ordem crescente e sem repetições.
 *
 * Uma nota sobre o limite superior: em `monthly` e `custom` a data pode
 * ultrapassar `range.end` em até 2 dias, porque o desvio de fim de semana é
 * aplicado DEPOIS de a ocorrência ser escolhida. É deliberado e vem do
 * comportamento anterior — sem isso, uma ocorrência ancorada em 31/01 (sábado)
 * desaparecia por completo ao gerar o mês de janeiro, em vez de acontecer a
 * 02/02. O limite inferior (`range.start`) é sempre respeitado.
 */
export function occurrencesInRange(rule: RecurrenceRule, range: CivilRange): CivilDate[] {
  // Parsing estrito: uma data corrompida ("72026-01-01", "2026-02-30") nunca
  // produz ocorrências em vez de produzir lixo silencioso.
  if (!isValidCivilDate(rule.startsOn)) return [];
  if (rule.endsOn != null && !isValidCivilDate(rule.endsOn)) return [];
  if (!isValidCivilDate(range.start) || !isValidCivilDate(range.end)) return [];
  if (range.end < range.start) return [];

  const startsOn = rule.startsOn;
  const endsOn = rule.endsOn ?? null;
  if (endsOn && endsOn < startsOn) return [];
  const excluded = new Set(rule.excludedDates ?? []);

  /** Limites comuns a todas as frequências. */
  function withinContract(date: CivilDate): boolean {
    if (date < range.start) return false;
    if (date < startsOn) return false;
    if (endsOn && date > endsOn) return false;
    return !excluded.has(date);
  }
  /** Idem, mas também limitado por `range.end` (frequências sem desvio). */
  function withinRange(date: CivilDate): boolean {
    return date <= range.end && withinContract(date);
  }

  const results: CivilDate[] = [];
  const frequency = rule.frequency;

  if (frequency === "daily") {
    // "Diário" no produto é "todos os dias úteis" — nunca gerou em fim de
    // semana. Salta, não empurra (empurrar perderia o dia).
    const from = maxDate(range.start, startsOn);
    const to = endsOn ? minDate(range.end, endsOn) : range.end;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!isWeekend(d) && withinRange(d)) results.push(d);
    }
  } else if (Object.hasOwn(CADENCE_WEEKS, frequency)) {
    const cadence = CADENCE_WEEKS[frequency];
    const weekdays = rule.weekdays ?? [];
    if (weekdays.length === 0) return [];

    // A cadência é contada em SEMANAS CIVIS inteiras a partir da segunda-feira
    // da semana em que o contrato começa. Contar em milissegundos (o que o
    // código antigo fazia) desloca-se com o horário de verão e podia inverter
    // a paridade de um contrato quinzenal em março/outubro.
    const anchorMonday = startOfWeek(startsOn);
    const to = endsOn ? minDate(range.end, endsOn) : range.end;
    const offsets = [...new Set(weekdays)]
      .filter((dow) => Number.isInteger(dow) && dow >= 0 && dow <= 6)
      // Deslocamento a partir de segunda-feira (domingo é o fim da semana).
      .map((dow) => (dow === 0 ? 6 : dow - 1))
      .sort((a, b) => a - b);

    let weekStart = startOfWeek(maxDate(range.start, startsOn));
    while (weekStart <= to) {
      const weekIndex = Math.floor(daysBetween(anchorMonday, weekStart) / 7);
      if (weekIndex >= 0 && mod(weekIndex, cadence) === 0) {
        for (const offset of offsets) {
          const date = addDays(weekStart, offset);
          if (withinRange(date)) results.push(date);
        }
      }
      weekStart = addDays(weekStart, 7);
    }
  } else if (frequency === "monthly") {
    // Âncora = o dia do mês em que o contrato começa. Preservada tal e qual:
    // um contrato ancorado no dia 31 dá 31/jan, 28/fev, 31/mar — o clamp de
    // fevereiro NUNCA reescreve a âncora para 28.
    const anchorDay = partsOf(startsOn).day;
    // Um mês para trás de propósito: a ocorrência de 31/01 (sábado) é
    // empurrada para 02/02 e pertence, nessa data, ao intervalo de fevereiro.
    // Sem esta janela, quem consultasse fevereiro não a via — e a
    // reconciliação de contratos apagava o serviço por o considerar órfão.
    let month = addMonths(startOfMonth(range.start), -1);
    const lastMonth = startOfMonth(range.end);
    while (month <= lastMonth) {
      const { year, month: m } = partsOf(month);
      // `civilDate` limita ao último dia do mês (28/29/30/31) em vez de deixar
      // o `Date` transbordar silenciosamente para o mês seguinte.
      const base = civilDate(year, m, anchorDay);
      // A ocorrência tem de pertencer ao intervalo ANTES do desvio: sem isto,
      // pedir só o dia 10 devolvia a ocorrência do dia 15 desse mês.
      if (base <= range.end) {
        const shifted = shiftWeekendForward(base);
        if (withinContract(shifted)) results.push(shifted);
      }
      month = addMonths(month, 1);
    }
  } else if (frequency === "custom") {
    const step = Math.max(1, Math.floor(rule.intervalDays ?? 1));
    // Salta direto para a primeira data-base relevante em vez de percorrer o
    // contrato desde o início: um contrato de 2020 consultado para agosto de
    // 2026 não gera seis anos de datas só para as deitar fora a seguir.
    // A folga de 2 dias cobre a base de sábado/domingo que é empurrada para
    // dentro do intervalo.
    const earliestBase = addDays(range.start, -2);
    const gap = daysBetween(startsOn, earliestBase);
    const skipped = gap <= 0 ? 0 : Math.ceil(gap / step);
    for (let base = addDays(startsOn, skipped * step); base <= range.end; base = addDays(base, step)) {
      const shifted = shiftWeekendForward(base);
      if (withinContract(shifted)) results.push(shifted);
    }
  }

  // Deduplicação e ordenação finais. Várias regras podem convergir no mesmo
  // dia (duas datas-base empurradas para a mesma segunda-feira, por exemplo) e
  // o consumidor nunca deve ver o mesmo dia duas vezes.
  return [...new Set(results)].sort();
}

/**
 * As próximas `count` ocorrências a partir de `from` (inclusive).
 *
 * Existe para os previews (formulário de contratos, coluna "próxima
 * ocorrência" da tabela), que antes tinham cada um a sua própria implementação
 * da recorrência — e discordavam do que era realmente gerado.
 *
 * Avança por janelas para não ter de escolher um intervalo arbitrário à
 * partida. `horizonDays` limita a procura para um contrato sem ocorrências
 * futuras não varrer indefinidamente.
 */
export function nextOccurrences(
  rule: RecurrenceRule,
  from: string,
  count: number,
  horizonDays = 3 * 366,
): CivilDate[] {
  if (count <= 0 || !isValidCivilDate(from)) return [];

  const found = new Set<CivilDate>();
  const WINDOW_DAYS = 92; // ~3 meses por janela
  let windowStart = from;
  let scanned = 0;

  while (found.size < count && scanned < horizonDays) {
    if (rule.endsOn && windowStart > rule.endsOn) break;
    const windowEnd = addDays(windowStart, WINDOW_DAYS - 1);
    for (const date of occurrencesInRange(rule, { start: windowStart, end: windowEnd })) {
      if (date >= from) found.add(date);
    }
    windowStart = addDays(windowEnd, 1);
    scanned += WINDOW_DAYS;
  }

  return [...found].sort().slice(0, count);
}

function maxDate(a: CivilDate, b: CivilDate): CivilDate {
  return a > b ? a : b;
}

function minDate(a: CivilDate, b: CivilDate): CivilDate {
  return a < b ? a : b;
}
