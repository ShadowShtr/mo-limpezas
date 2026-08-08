// ============================================================================
// T14 — Períodos civis e interseção
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não conhece Supabase nem o relógio
// do sistema. Nenhuma função aqui altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// Um relatório pergunta "quanto aconteceu entre X e Y". Quase todos os registos
// do sistema, porém, não são pontos: são intervalos. Uma ausência vai de
// `starts_on` a `ends_on`. Um contrato vai de `starts_on` a `ends_on`. Uma
// fatura cobre `period_start`–`period_end`.
//
// O código actual trata-os como se fossem pontos. Em `src/app/actions/reports.ts`
// (bloco ABSENTISMO) a consulta filtra correctamente por sobreposição:
//
//     .lte("starts_on", endDate).gte("ends_on", startDate)
//
// mas depois conta os dias assim:
//
//     dias = (ends_on − starts_on) / 1 dia + 1
//
// — o intervalo INTEIRO da ausência, não a parte que cai dentro do relatório.
// Uma ausência de 1 de agosto a 30 de setembro aparece no relatório de agosto
// com 61 dias. O mês de agosto tem 31.
//
// O mesmo erro conta a ausência duas vezes: 61 dias em agosto e 61 dias em
// setembro, 122 dias no total para uma ausência de 61.
//
// Este módulo dá a operação em falta: interseção. Um registo contribui para um
// relatório apenas com os dias que estão dentro do relatório.
//
// ----------------------------------------------------------------------------
//
// Porquê datas civis e não `Date`.
//
// `starts_on` e `ends_on` são colunas `DATE`. Não têm hora, não têm fuso. Ler
// "2026-08-01" para um `Date` obriga a inventar uma hora e um fuso, e é daí que
// vêm os desvios de ±1 dia (ver `src/domain/scheduling/civil-date.ts`). Aqui a
// aritmética é toda sobre dias civis inteiros.

import {
  type CivilDate,
  daysBetween,
  addDays,
  civilDate,
  daysInMonth,
  isValidCivilDate,
  partsOf,
} from "../scheduling/civil-date";

/**
 * Intervalo de dias civis, **fechado dos dois lados**.
 *
 * `{ start: "2026-08-01", end: "2026-08-31" }` é agosto inteiro: 31 dias, com o
 * dia 31 incluído. Escolhido fechado (e não meio-aberto) porque é a forma como
 * o schema já guarda os intervalos (`absences.ends_on` é o último dia da
 * ausência, não o dia seguinte) e porque converter uma vez na fronteira é menos
 * arriscado do que ter as duas convenções a circular no mesmo domínio.
 */
export interface CivilPeriod {
  start: CivilDate;
  end: CivilDate;
}

/**
 * Constrói um período validado. Devolve `null` — nunca lança, nunca "corrige" —
 * quando as datas são inválidas ou estão invertidas.
 *
 * Devolver `null` em vez de trocar `start` com `end` é deliberado: um
 * `ends_on` anterior ao `starts_on` é um dado corrompido (já aconteceu em
 * produção, ver `safeFormat` em `src/lib/utils.ts`), e silenciá-lo faria o
 * relatório apresentar um número plausível construído sobre lixo. Quem chama
 * recebe `null` e regista um `IntegrityIssue`.
 */
export function makePeriod(start: unknown, end: unknown): CivilPeriod | null {
  if (!isValidCivilDate(start) || !isValidCivilDate(end)) return null;
  if (start > end) return null;
  return { start, end };
}

/** Período de um único dia. */
export function dayPeriod(date: CivilDate): CivilPeriod | null {
  return makePeriod(date, date);
}

/** Mês civil completo. `month` é 1–12. */
export function monthPeriod(year: number, month: number): CivilPeriod | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  return makePeriod(civilDate(year, month, 1), civilDate(year, month, daysInMonth(year, month)));
}

/** Mês civil a que uma data pertence. */
export function monthPeriodOf(date: CivilDate): CivilPeriod | null {
  if (!isValidCivilDate(date)) return null;
  const { year, month } = partsOf(date);
  return monthPeriod(year, month);
}

/** Número de dias civis do período (fechado: 1 de agosto a 1 de agosto = 1). */
export function periodDays(period: CivilPeriod): number {
  return daysBetween(period.start, period.end) + 1;
}

/** `true` se a data cai dentro do período (extremos incluídos). */
export function containsDate(period: CivilPeriod, date: CivilDate): boolean {
  if (!isValidCivilDate(date)) return false;
  return date >= period.start && date <= period.end;
}

/**
 * Parte comum a dois períodos, ou `null` se não se tocam.
 *
 * É a operação que falta em todo o código de relatórios. Dois períodos que
 * apenas se tocam num dia (agosto termina a 31, setembro começa a 1) **não**
 * se intersectam — não partilham nenhum dia.
 */
export function intersectPeriods(a: CivilPeriod, b: CivilPeriod): CivilPeriod | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  if (start > end) return null;
  return { start, end };
}

/** `true` se os dois períodos partilham pelo menos um dia. */
export function periodsOverlap(a: CivilPeriod, b: CivilPeriod): boolean {
  return intersectPeriods(a, b) !== null;
}

/**
 * Dias de `record` que caem dentro de `window`. Zero se não se tocam.
 *
 * É este número — e não `periodDays(record)` — que um relatório deve somar.
 * A soma sobre meses consecutivos dá exactamente a duração do registo, sem
 * dupla contagem e sem perder dias.
 */
export function intersectionDays(record: CivilPeriod, window: CivilPeriod): number {
  const overlap = intersectPeriods(record, window);
  return overlap === null ? 0 : periodDays(overlap);
}

/**
 * Fracção do registo que cai na janela, entre 0 e 1.
 *
 * Existe para repartir grandezas proporcionais ao tempo (não para dinheiro de
 * avença: essa distribuição é por ocorrência e vive em
 * `src/domain/billing/monthly-allocation.ts`, com política `PRORATED` ainda em
 * standby por decisão de negócio).
 */
export function intersectionFraction(record: CivilPeriod, window: CivilPeriod): number {
  const total = periodDays(record);
  if (total <= 0) return 0;
  return intersectionDays(record, window) / total;
}

/**
 * Dias do período, um a um, por ordem cronológica.
 *
 * Usado para construir séries diárias com os dias vazios incluídos — um dia sem
 * serviços tem de aparecer como zero no gráfico, não desaparecer do eixo. É
 * exactamente o que a Faturação Diária dos Relatórios faz hoje errado: constrói
 * o mapa só a partir dos dias que têm serviço.
 */
export function eachDay(period: CivilPeriod): CivilDate[] {
  const out: CivilDate[] = [];
  let cursor = period.start;
  while (cursor <= period.end) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Rótulo estável do período, para chaves de série e para o `key` do
 * `FinancialPeriod` da T11. Não é texto de apresentação.
 */
export function periodKey(period: CivilPeriod): string {
  if (period.start === period.end) return period.start;
  const a = partsOf(period.start);
  const b = partsOf(period.end);
  if (
    a.year === b.year && a.month === b.month
    && a.day === 1 && b.day === daysInMonth(b.year, b.month)
  ) {
    return period.start.slice(0, 7);
  }
  return `${period.start}..${period.end}`;
}

/** `true` se o período é exactamente um mês civil completo. */
export function isWholeMonth(period: CivilPeriod): boolean {
  const a = partsOf(period.start);
  const b = partsOf(period.end);
  return (
    a.year === b.year
    && a.month === b.month
    && a.day === 1
    && b.day === daysInMonth(b.year, b.month)
  );
}

/**
 * Meses civis tocados pelo período, por ordem.
 *
 * Um relatório de 25 de julho a 5 de agosto atravessa dois meses. Qualquer
 * grandeza mensal (avença, folha, fatura de período) tem de ser resolvida mês a
 * mês — foi por não o fazer que o Dashboard Financeiro passou a usar um
 * denominador de avença menor do que o real numa semana a cavalo de dois meses.
 */
export function monthsCovered(period: CivilPeriod): CivilPeriod[] {
  const out: CivilPeriod[] = [];
  const last = partsOf(period.end);
  let { year, month } = partsOf(period.start);
  for (;;) {
    const m = monthPeriod(year, month);
    if (m) out.push(m);
    if (year === last.year && month === last.month) break;
    if (out.length > 1200) break; // rede de segurança contra datas corrompidas
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * `true` se a janela cobre por inteiro o mês da data.
 *
 * A pergunta que o Dashboard Financeiro nunca fez antes de dividir uma avença.
 * Quando é `false`, o denominador da avença não pode sair dos dados carregados:
 * ou se carrega o mês inteiro, ou o valor fica `PARTIAL`.
 */
export function coversWholeMonthOf(window: CivilPeriod, date: CivilDate): boolean {
  const month = monthPeriodOf(date);
  if (!month) return false;
  return window.start <= month.start && window.end >= month.end;
}
