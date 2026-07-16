// Geração de ocorrências de um contrato — partilhado entre a geração imediata
// (createContrato/updateContrato) e o cron mensal (generate-services), para
// as duas nunca voltarem a divergir (já tinham ficado dessincronizadas: só
// o preview do formulário fazia "diário" saltar fins de semana).
import type { ScheduleDay } from "@/types/database";

export const DOW_TO_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

const CADENCE_WEEKS: Record<string, number> = { weekly: 1, biweekly: 2, triweekly: 3 };

export interface OccurrenceContract {
  frequency: string;
  weekdays: number[] | null;
  interval_days: number;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  excluded_dates?: string[] | null;
}

/**
 * Fim de semana (sáb/dom) empurra para a próxima segunda-feira. Só faz
 * sentido em frequências onde o dia da semana é arbitrário (mensal,
 * personalizado) — em semanal/quinzenal/3-em-3-semanas o dia é escolhido
 * explicitamente pela pessoa, empurrar aí criaria colisão com outro dia já
 * escolhido no mesmo contrato.
 */
export function shiftToNextBusinessDay(date: Date): Date {
  const dow = date.getDay();
  const shifted = new Date(date);
  if (dow === 6) shifted.setDate(shifted.getDate() + 2);      // sábado → segunda
  else if (dow === 0) shifted.setDate(shifted.getDate() + 1); // domingo → segunda
  return shifted;
}

export function getOccurrences(
  contract: OccurrenceContract,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ date: Date; schedule: ScheduleDay }> {
  const results: Array<{ date: Date; schedule: ScheduleDay }> = [];
  const defaultSchedule = contract.schedule_days?.[0];
  if (!defaultSchedule) return [];

  const contractStart = new Date(contract.starts_on + "T00:00:00");
  const contractEnd = contract.ends_on ? new Date(contract.ends_on + "T23:59:59") : null;
  // Datas excluídas manualmente (apagadas do calendário) — nunca são recriadas.
  const excluded = new Set(contract.excluded_dates ?? []);

  // Mensal/personalizado: a data é empurrada por cima de fim de semana, logo
  // pode ultrapassar `rangeEnd` em até 2 dias — não bloqueado pelo limite
  // superior, só pelo início do contrato/fim/exclusões. `rangeStart` continua
  // a limitar para não reprocessar todo o histórico do contrato a cada corrida.
  function inRangeShiftable(d: Date): boolean {
    return d >= rangeStart && d >= contractStart
      && (!contractEnd || d <= contractEnd) && !excluded.has(toDateStr(d));
  }
  function inRange(d: Date): boolean {
    return d >= rangeStart && d <= rangeEnd && d >= contractStart
      && (!contractEnd || d <= contractEnd) && !excluded.has(toDateStr(d));
  }

  if (contract.frequency === "daily") {
    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
      const dow = cursor.getDay();
      // "Diário" é rotulado como "todos os dias úteis" — nunca gerou em
      // sáb/dom (não faz sentido empurrar, perderia o dia, por isso salta).
      if (dow !== 0 && dow !== 6 && inRange(cursor)) {
        results.push({ date: new Date(cursor), schedule: defaultSchedule });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (Object.hasOwn(CADENCE_WEEKS, contract.frequency)) {
    const cadence = CADENCE_WEEKS[contract.frequency];
    const weekdays = contract.weekdays ?? [];
    const startWeekNum = Math.floor(contractStart.getTime() / (7 * 24 * 3600 * 1000));
    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
      const dow = cursor.getDay();
      if (weekdays.includes(dow)) {
        const thisWeekNum = Math.floor(cursor.getTime() / (7 * 24 * 3600 * 1000));
        const isCorrectWeek = cadence === 1 || (thisWeekNum - startWeekNum) % cadence === 0;
        if (isCorrectWeek && inRange(cursor)) {
          const dayKey = DOW_TO_KEY[dow];
          const schedule = contract.schedule_days.find((s) => s.day === dayKey) ?? defaultSchedule;
          results.push({ date: new Date(cursor), schedule });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (contract.frequency === "monthly") {
    const dayOfMonth = contractStart.getDate();
    const target = shiftToNextBusinessDay(
      new Date(rangeStart.getFullYear(), rangeStart.getMonth(), dayOfMonth),
    );
    if (inRangeShiftable(target)) results.push({ date: target, schedule: defaultSchedule });
  } else if (contract.frequency === "custom") {
    const step = Math.max(1, contract.interval_days ?? 1);
    const cursor = new Date(contractStart);
    // Empurrar por cima de fim de semana pode fazer duas datas-base seguidas
    // (ex.: sáb/dom com intervalo de 1 dia) caírem na mesma segunda — nunca
    // gerar duas ocorrências no mesmo dia.
    const usedDates = new Set<string>();
    while (cursor <= rangeEnd) {
      const shifted = shiftToNextBusinessDay(cursor);
      const shiftedStr = toDateStr(shifted);
      if (inRangeShiftable(shifted) && !usedDates.has(shiftedStr)) {
        usedDates.add(shiftedStr);
        results.push({ date: shifted, schedule: defaultSchedule });
      }
      cursor.setDate(cursor.getDate() + step);
    }
  }

  return results;
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
