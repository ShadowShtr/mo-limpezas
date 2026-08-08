// ============================================================================
// T14 — Métricas operacionais
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não altera dados.
//
// ----------------------------------------------------------------------------
//
// Dois defeitos que isto fecha.
//
// 1. **Estados agrupados por omissão.** `src/app/actions/reports.ts` conta assim:
//
//        if (status === "concluido") …
//        else if (status === "cancelado") …
//        else if (status === "falta") …
//        else entry.agendado += 1        ← tudo o resto
//
//    O `else` final engole `em_curso` E `sem_cobertura`. Um serviço que ficou
//    sem equipa aparece na coluna "Agendado", indistinguível de um serviço
//    normal por acontecer. E se um dia a base tiver um estado que o schema não
//    prevê, ele também entra em "Agendado" — sem aviso nenhum.
//
// 2. **Horas com nomes trocados.** O relatório chama "Horas trabalhadas" à soma
//    de `timesheets.duration_minutes`, o que está certo, mas o dashboard usa
//    "horas" para outras coisas. A T14 separa três grandezas que nunca devem
//    ser somadas entre si:
//
//        scheduledHours — o que estava planeado (services)
//        workedHours    — o que foi picado ao ponto (timesheets)
//        absenceHours   — ausência convertida em horas, SE houver regra
//
//    `workedHours + absenceHours` **não** é a jornada e não deve ser
//    apresentado como tal: um serviço cancelado não tem ponto nem ausência, e
//    uma ausência num dia sem serviço planeado não subtrai nada.

import { type CivilPeriod, containsDate } from "./period";
import {
  type ServiceInput,
  type TimesheetInput,
  isServiceStatus,
} from "./report-sources";
import { type IntegrityIssue, issue } from "./integrity";

/**
 * Contagem por estado. Um campo por estado real do schema (migration 006), mais
 * `unknown` para o que a base tiver e o CHECK não previr.
 */
export interface ServiceCounts {
  agendado: number;
  em_curso: number;
  concluido: number;
  cancelado: number;
  falta: number;
  sem_cobertura: number;
  /** Estados fora do CHECK. Nunca somado a nenhum dos outros. */
  unknown: number;
  /** Todas as linhas contadas, incluindo canceladas e desconhecidas. */
  total: number;
}

export function emptyServiceCounts(): ServiceCounts {
  return {
    agendado: 0,
    em_curso: 0,
    concluido: 0,
    cancelado: 0,
    falta: 0,
    sem_cobertura: 0,
    unknown: 0,
    total: 0,
  };
}

/**
 * `true` se o estado ocupa a agenda.
 *
 * Cancelado não ocupa. Falta ocupa — a equipa deslocou-se ou o espaço ficou
 * reservado, e é assim que a avença já é cobrada hoje (ver `isEligible` em
 * `src/domain/billing/consumer-parity.ts`). `sem_cobertura` ocupa: está na
 * agenda e não foi cancelado.
 */
export function occupiesSchedule(status: string): boolean {
  return status !== "cancelado";
}

/** `true` se o estado representa trabalho realizado. Só `concluido`. */
export function isPerformed(status: string): boolean {
  return status === "concluido";
}

/** Horas com uma origem declarada. Nunca um número solto. */
export interface HoursMetric {
  /** `null` quando não há base para calcular. **Não é zero.** */
  hours: number | null;
  origin: "services_scheduled" | "timesheets" | "absences";
  note?: string;
}

export interface OperationalMetrics {
  counts: ServiceCounts;
  /** Serviços que ocupam a agenda (tudo menos cancelado). */
  scheduled: number;
  /** Serviços concluídos. */
  completed: number;
  /** Serviços cancelados. */
  cancelled: number;
  /** Serviços com falta registada. */
  absences: number;
  scheduledHours: HoursMetric;
  workedHours: HoursMetric;
  absenceHours: HoursMetric;
  /** Dias de ausência dentro do período (de `absence-metrics.ts`). */
  absenceDays: number | null;
  issues: IntegrityIssue[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Conta os serviços por estado e detecta o que não bate certo.
 *
 * Deteta:
 *   • `id` repetido no conjunto carregado (`DUPLICATE_SERVICE_ID`) — o sintoma
 *     de duplicação de ocorrências que a T08 diagnosticou;
 *   • estado fora do CHECK (`UNKNOWN_STATUS`);
 *   • linha carregada cuja data está fora da janela (`RECORD_OUTSIDE_PERIOD`),
 *     que é como um intervalo de consulta errado se manifesta.
 */
export function countServices(
  services: readonly ServiceInput[],
  window: CivilPeriod,
): { counts: ServiceCounts; issues: IntegrityIssue[]; accepted: ServiceInput[] } {
  const counts = emptyServiceCounts();
  const issues: IntegrityIssue[] = [];
  const accepted: ServiceInput[] = [];
  const seen = new Set<string>();

  for (const s of services) {
    if (seen.has(s.id)) {
      issues.push(
        issue("DUPLICATE_SERVICE_ID", {
          source: "services",
          subject: s.id,
          detail: "o mesmo services.id apareceu duas vezes no conjunto carregado",
        }),
      );
      continue;
    }
    seen.add(s.id);

    if (!containsDate(window, s.occurrenceDate)) {
      issues.push(
        issue("RECORD_OUTSIDE_PERIOD", {
          source: "services",
          subject: s.id,
          detail: `data ${s.occurrenceDate} fora de ${window.start}..${window.end}`,
        }),
      );
      continue;
    }

    accepted.push(s);
    counts.total += 1;

    if (!isServiceStatus(s.status)) {
      counts.unknown += 1;
      issues.push(
        issue("UNKNOWN_STATUS", {
          source: "services",
          subject: s.id,
          detail: `status fora do CHECK do schema: ${s.status}`,
        }),
      );
      continue;
    }

    counts[s.status] += 1;
  }

  return { counts, issues, accepted };
}

/**
 * Horas planeadas, a partir de `scheduled_start`/`scheduled_end`.
 *
 * Só conta o que ocupa a agenda. Um serviço sem duração planeada não conta como
 * zero: torna a métrica `PARTIAL` através da nota, porque somar zero faria as
 * horas planeadas parecerem menores do que são.
 */
export function computeScheduledHours(services: readonly ServiceInput[]): HoursMetric {
  let minutes = 0;
  let missing = 0;
  let counted = 0;

  for (const s of services) {
    if (!occupiesSchedule(s.status)) continue;
    if (s.scheduledMinutes == null || !Number.isFinite(s.scheduledMinutes)) {
      missing += 1;
      continue;
    }
    minutes += s.scheduledMinutes;
    counted += 1;
  }

  if (counted === 0 && missing > 0) {
    return {
      hours: null,
      origin: "services_scheduled",
      note: `nenhum dos ${missing} serviços tem duração planeada`,
    };
  }

  return {
    hours: round2(minutes / 60),
    origin: "services_scheduled",
    note: missing > 0 ? `${missing} serviço(s) sem duração planeada` : undefined,
  };
}

/**
 * Horas picadas ao ponto.
 *
 * Um `duration_minutes` a `null` é um ponto ainda ABERTO (clock-in sem
 * clock-out), não um turno de zero minutos. Contá-lo como zero é o que faz as
 * horas do dia corrente parecerem menores do que são; aqui fica registado na
 * nota.
 */
export function computeWorkedHours(timesheets: readonly TimesheetInput[]): HoursMetric {
  let minutes = 0;
  let open = 0;

  for (const t of timesheets) {
    if (t.durationMinutes == null || !Number.isFinite(t.durationMinutes)) {
      open += 1;
      continue;
    }
    minutes += t.durationMinutes;
  }

  return {
    hours: round2(minutes / 60),
    origin: "timesheets",
    note: open > 0 ? `${open} ponto(s) ainda por fechar` : undefined,
  };
}

/**
 * Horas de ausência. `null` quando não há jornada declarada — ver o cabeçalho
 * de `absence-metrics.ts`. **Nunca inventar 8 h/dia.**
 */
export function computeAbsenceHours(
  absenceDays: number | null,
  hoursPerDay: number | null,
): HoursMetric {
  if (absenceDays == null) {
    return { hours: null, origin: "absences", note: "dias de ausência indisponíveis" };
  }
  if (hoursPerDay == null || !Number.isFinite(hoursPerDay) || hoursPerDay < 0) {
    return {
      hours: null,
      origin: "absences",
      note: "sem jornada diária declarada — o schema não define nenhuma",
    };
  }
  return { hours: round2(absenceDays * hoursPerDay), origin: "absences" };
}

/** Filtra os pontos que caem dentro da janela, registando os que não caem. */
export function filterTimesheets(
  timesheets: readonly TimesheetInput[],
  window: CivilPeriod,
): { accepted: TimesheetInput[]; issues: IntegrityIssue[] } {
  const accepted: TimesheetInput[] = [];
  const issues: IntegrityIssue[] = [];
  for (const t of timesheets) {
    if (!containsDate(window, t.date)) {
      issues.push(
        issue("RECORD_OUTSIDE_PERIOD", {
          source: "timesheets",
          subject: t.id,
          detail: `data ${t.date} fora de ${window.start}..${window.end}`,
        }),
      );
      continue;
    }
    accepted.push(t);
  }
  return { accepted, issues };
}

/** Reúne tudo o que é operacional numa estrutura só. */
export function buildOperationalMetrics(input: {
  services: readonly ServiceInput[];
  timesheets: readonly TimesheetInput[];
  window: CivilPeriod;
  absenceDays: number | null;
  /** Jornada diária, se o negócio a tiver definido. Nunca por omissão. */
  absenceHoursPerDay?: number | null;
}): OperationalMetrics {
  const { counts, issues: countIssues, accepted } = countServices(input.services, input.window);
  const { accepted: sheets, issues: sheetIssues } = filterTimesheets(
    input.timesheets,
    input.window,
  );

  return {
    counts,
    scheduled: counts.total - counts.cancelado,
    completed: counts.concluido,
    cancelled: counts.cancelado,
    absences: counts.falta,
    scheduledHours: computeScheduledHours(accepted),
    workedHours: computeWorkedHours(sheets),
    absenceHours: computeAbsenceHours(input.absenceDays, input.absenceHoursPerDay ?? null),
    absenceDays: input.absenceDays,
    issues: [...countIssues, ...sheetIssues],
  };
}

/** Soma métricas operacionais de vários períodos. Contagens e horas são aditivas. */
export function sumOperationalMetrics(
  parts: readonly OperationalMetrics[],
): OperationalMetrics {
  const counts = emptyServiceCounts();
  const issues: IntegrityIssue[] = [];

  const addHours = (
    selector: (m: OperationalMetrics) => HoursMetric,
    origin: HoursMetric["origin"],
  ): HoursMetric => {
    let total = 0;
    let anyNull = false;
    for (const p of parts) {
      const h = selector(p).hours;
      if (h == null) anyNull = true;
      else total += h;
    }
    if (anyNull && total === 0) return { hours: null, origin, note: "pelo menos um período sem base" };
    return {
      hours: round2(total),
      origin,
      note: anyNull ? "pelo menos um período sem base — total incompleto" : undefined,
    };
  };

  let absenceDays: number | null = 0;
  for (const p of parts) {
    for (const key of Object.keys(counts) as (keyof ServiceCounts)[]) {
      counts[key] += p.counts[key];
    }
    issues.push(...p.issues);
    if (p.absenceDays == null) absenceDays = null;
    else if (absenceDays != null) absenceDays += p.absenceDays;
  }

  return {
    counts,
    scheduled: counts.total - counts.cancelado,
    completed: counts.concluido,
    cancelled: counts.cancelado,
    absences: counts.falta,
    scheduledHours: addHours((m) => m.scheduledHours, "services_scheduled"),
    workedHours: addHours((m) => m.workedHours, "timesheets"),
    absenceHours: addHours((m) => m.absenceHours, "absences"),
    absenceDays,
    issues,
  };
}
