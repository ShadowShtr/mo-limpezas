// Adaptador entre o motor canónico de recorrência e os consumidores que
// trabalham com `Date` e com os horários (`schedule_days`) do contrato.
//
// A REGRA de recorrência vive toda em `@/domain/scheduling/recurrence-engine`
// e não deve ser reimplementada aqui nem em nenhum consumidor. Este ficheiro
// só faz duas coisas: traduzir `Date` ↔ data civil na fronteira, e escolher o
// horário certo para cada ocorrência.
import type { ScheduleDay } from "@/types/database";
import {
  occurrencesInRange,
  type RecurrenceRule,
} from "@/domain/scheduling/recurrence-engine";
import { fromLocalDate, toLocalDate } from "@/domain/scheduling/civil-date";

export const DOW_TO_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

export interface OccurrenceContract {
  frequency: string;
  weekdays: number[] | null;
  interval_days: number;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  excluded_dates?: string[] | null;
}

/** Converte o contrato guardado na base para a regra do motor. */
export function toRecurrenceRule(contract: OccurrenceContract): RecurrenceRule {
  return {
    frequency: contract.frequency,
    weekdays: contract.weekdays,
    intervalDays: contract.interval_days,
    startsOn: contract.starts_on,
    endsOn: contract.ends_on,
    excludedDates: contract.excluded_dates,
  };
}

/**
 * Ocorrências do contrato no intervalo, já com o horário de cada dia.
 *
 * `rangeStart`/`rangeEnd` são lidos pelos seus campos LOCAIS (o dia que
 * mostram), e as datas devolvidas são `Date` à meia-noite local — a
 * representação que o calendário e as actions já esperam.
 */
export function getOccurrences(
  contract: OccurrenceContract,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ date: Date; schedule: ScheduleDay }> {
  const defaultSchedule = contract.schedule_days?.[0];
  if (!defaultSchedule) return [];

  const dates = occurrencesInRange(toRecurrenceRule(contract), {
    start: fromLocalDate(rangeStart),
    end: fromLocalDate(rangeEnd),
  });

  return dates.map((civil) => {
    const date = toLocalDate(civil);
    // Com vários dias da semana escolhidos, cada dia pode ter o seu horário e
    // a sua equipa; nas outras frequências há um horário só.
    const dayKey = DOW_TO_KEY[date.getDay()];
    const schedule = contract.schedule_days.find((s) => s.day === dayKey) ?? defaultSchedule;
    return { date, schedule };
  });
}
