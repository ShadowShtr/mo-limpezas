// Motor canónico de recorrência de contratos.
//
// Única implementação de "que dias este contrato gera" — mensal, semanal,
// quinzenal, 3-em-3-semanas, diário e personalizado. Antes desta unificação
// havia DUAS implementações independentes (src/lib/contract-occurrences.ts
// para geração real/cron e um `calcOccurrences` local em sheet.tsx só para o
// preview do formulário) que já tinham divergido uma vez no passado (o
// preview de "diário" chegou a não saltar fins de semana enquanto a geração
// real saltava). Qualquer sítio do código que precise de saber as datas de
// um contrato deve consumir este módulo — nunca reimplementar o cálculo.
//
// src/lib/contract-occurrences.ts continua a existir como wrapper de
// compatibilidade (mesmos nomes/assinaturas que o resto do código já
// importa), mas não tem lógica própria — só re-exporta daqui.
import type { ScheduleDay } from "@/types/database";

export const DOW_TO_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

const CADENCE_WEEKS: Record<string, number> = { weekly: 1, biweekly: 2, triweekly: 3 };

// Frequências em que a data devolvida pode ser diferente da data-base do
// ciclo (desvio de fim de semana para a próxima 2ª feira, até +2 dias).
const SHIFTED_FREQUENCIES = new Set(["monthly", "custom"]);
const MAX_SHIFT_MS = 2 * 24 * 3600 * 1000;

// Travões de segurança: o gerador nunca deve correr para sempre num contrato
// sem `ends_on` (aberto) se algum consumidor esquecer de parar de iterar.
// ~20 anos de dias/meses — generoso para o horizonte real de um contrato de
// limpeza, mas finito.
const MAX_DAILY_STEPS = 20 * 366;
const MAX_MONTHLY_STEPS = 20 * 12;

export interface RecurrenceContract {
  frequency: string;
  weekdays: number[] | null;
  interval_days: number;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  excluded_dates?: string[] | null;
}

export interface RecurrenceOccurrence {
  date: Date;
  schedule: ScheduleDay;
}

/**
 * Fim de semana (sáb/dom) empurra para a próxima segunda-feira. Só faz
 * sentido em frequências onde o dia da semana é arbitrário (mensal,
 * personalizado) — em semanal/quinzenal/3-em-3-semanas o dia é escolhido
 * explicitamente pela pessoa; empurrar aí criaria colisão com outro dia já
 * escolhido no mesmo contrato.
 */
export function shiftToNextBusinessDay(date: Date): Date {
  const dow = date.getDay();
  const shifted = new Date(date);
  if (dow === 6) shifted.setDate(shifted.getDate() + 2);      // sábado → segunda
  else if (dow === 0) shifted.setDate(shifted.getDate() + 1); // domingo → segunda
  return shifted;
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Gerador canónico: produz ocorrências em ordem cronológica crescente a
 * partir de `from` (ou do início do contrato, o que for mais tarde), até ao
 * fim do contrato (`ends_on`) ou ao travão de segurança.
 *
 * Não aplica limite superior de intervalo — é o consumidor que decide
 * quando parar de iterar (occurrencesInRange corta por data, occurrencesFrom
 * corta por contagem). Como é um gerador, nada é calculado além do que for
 * efetivamente consumido.
 */
export function* iterateOccurrences(
  contract: RecurrenceContract,
  from: Date,
): Generator<RecurrenceOccurrence, void, void> {
  const defaultSchedule = contract.schedule_days?.[0];
  if (!defaultSchedule) return;

  const contractStart = new Date(contract.starts_on + "T00:00:00");
  const contractEnd = contract.ends_on ? new Date(contract.ends_on + "T23:59:59") : null;
  const excluded = new Set(contract.excluded_dates ?? []);
  const lowerBound = from > contractStart ? atMidnight(from) : atMidnight(contractStart);

  function passesEndAndExclusion(d: Date): boolean {
    return (!contractEnd || d <= contractEnd) && !excluded.has(toDateStr(d));
  }

  if (contract.frequency === "daily") {
    const cursor = new Date(lowerBound);
    for (let i = 0; i < MAX_DAILY_STEPS; i++) {
      if (contractEnd && cursor > contractEnd) return;
      const dow = cursor.getDay();
      // "Diário" é rotulado como "todos os dias úteis" — nunca gera em sáb/dom
      // (não faz sentido empurrar, perderia o dia, por isso salta).
      if (dow !== 0 && dow !== 6 && cursor >= lowerBound && passesEndAndExclusion(cursor)) {
        yield { date: new Date(cursor), schedule: defaultSchedule };
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return;
  }

  if (Object.hasOwn(CADENCE_WEEKS, contract.frequency)) {
    const cadence = CADENCE_WEEKS[contract.frequency];
    const weekdays = contract.weekdays ?? [];
    if (weekdays.length === 0) return;
    const startWeekNum = Math.floor(contractStart.getTime() / (7 * 24 * 3600 * 1000));
    const cursor = new Date(lowerBound);
    for (let i = 0; i < MAX_DAILY_STEPS; i++) {
      if (contractEnd && cursor > contractEnd) return;
      const dow = cursor.getDay();
      if (weekdays.includes(dow)) {
        const thisWeekNum = Math.floor(cursor.getTime() / (7 * 24 * 3600 * 1000));
        const isCorrectWeek = cadence === 1 || (thisWeekNum - startWeekNum) % cadence === 0;
        if (isCorrectWeek && cursor >= lowerBound && passesEndAndExclusion(cursor)) {
          const dayKey = DOW_TO_KEY[dow];
          const schedule = contract.schedule_days.find((s) => s.day === dayKey) ?? defaultSchedule;
          yield { date: new Date(cursor), schedule };
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return;
  }

  if (contract.frequency === "monthly") {
    // Corrige o bug histórico: antes só se calculava a ocorrência do MÊS de
    // `from`, mesmo quando o intervalo pedido pelo chamador cobria vários
    // meses (ex.: geração de 3 em 3 meses em createContrato/updateContrato
    // só criava 1 serviço em vez de 1 por mês). Aqui avançamos mês a mês a
    // partir do mês de `from` (nunca antes do mês de início do contrato).
    const dayOfMonth = contractStart.getDate();
    const contractStartMonth = new Date(contractStart.getFullYear(), contractStart.getMonth(), 1);
    let monthCursor = new Date(lowerBound.getFullYear(), lowerBound.getMonth(), 1);
    if (monthCursor < contractStartMonth) monthCursor = contractStartMonth;

    for (let i = 0; i < MAX_MONTHLY_STEPS; i++) {
      if (contractEnd && monthCursor > contractEnd) return;
      const target = shiftToNextBusinessDay(
        new Date(monthCursor.getFullYear(), monthCursor.getMonth(), dayOfMonth),
      );
      if (target >= lowerBound && target >= contractStart && passesEndAndExclusion(target)) {
        yield { date: target, schedule: defaultSchedule };
      }
      monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    }
    return;
  }

  if (contract.frequency === "custom") {
    // O passo avança sempre a partir do início do contrato (nunca de `from`)
    // — a fase do ciclo depende da data de início; saltar para `from` sem
    // recalcular a fase produziria datas erradas.
    const step = Math.max(1, contract.interval_days ?? 1);
    const cursor = new Date(contractStart);
    // Empurrar por cima de fim de semana pode fazer duas datas-base seguidas
    // (ex.: sáb/dom com intervalo de 1 dia) caírem na mesma segunda — nunca
    // gerar duas ocorrências no mesmo dia.
    const usedDates = new Set<string>();
    for (let i = 0; i < MAX_DAILY_STEPS; i++) {
      if (contractEnd && cursor > contractEnd) return;
      const shifted = shiftToNextBusinessDay(cursor);
      const shiftedStr = toDateStr(shifted);
      if (
        shifted >= lowerBound && shifted >= contractStart &&
        passesEndAndExclusion(shifted) && !usedDates.has(shiftedStr)
      ) {
        usedDates.add(shiftedStr);
        yield { date: shifted, schedule: defaultSchedule };
      }
      cursor.setDate(cursor.getDate() + step);
    }
    return;
  }
}

/**
 * Ocorrências cuja data-base cai entre rangeStart e rangeEnd (inclusive).
 * Mensal/personalizado toleram até 2 dias de desvio para além de rangeEnd
 * (o dia empurrado por fim de semana) — de propósito, para nunca perder uma
 * ocorrência só porque o desvio a empurrou para o mês/janela seguinte.
 */
export function occurrencesInRange(
  contract: RecurrenceContract,
  rangeStart: Date,
  rangeEnd: Date,
): RecurrenceOccurrence[] {
  const results: RecurrenceOccurrence[] = [];
  const tolerantEnd = SHIFTED_FREQUENCIES.has(contract.frequency)
    ? new Date(rangeEnd.getTime() + MAX_SHIFT_MS)
    : rangeEnd;

  for (const occ of iterateOccurrences(contract, rangeStart)) {
    if (occ.date > tolerantEnd) break;
    if (occ.date >= rangeStart) results.push(occ);
  }
  return results;
}

/**
 * Próximas `count` ocorrências a partir de `from` — usado por previews de
 * UI (não corta por data, corta por contagem).
 */
export function occurrencesFrom(
  contract: RecurrenceContract,
  from: Date,
  count: number,
): RecurrenceOccurrence[] {
  const results: RecurrenceOccurrence[] = [];
  for (const occ of iterateOccurrences(contract, from)) {
    results.push(occ);
    if (results.length >= count) break;
  }
  return results;
}
