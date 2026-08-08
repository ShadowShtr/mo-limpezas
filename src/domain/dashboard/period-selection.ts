// ============================================================================
// T15 — Selecção de períodos do dashboard
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, **não lê o relógio**. Nada aqui
// altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// `src/app/actions/financial-dashboard.ts` decide "hoje", "este mês" e "este
// ano" construindo um objecto de data sem argumentos e lendo-lhe `getFullYear`
// e `getMonth` — o mesmo padrão repetido dentro de `last12Months()`.
//
// O processo corre em **UTC** na Vercel — não há `TZ` configurada (ver a
// auditoria de 2026-07-06 no `CLAUDE.md`). Na primeira hora do dia 1 em hora de
// verão, `getMonth()` ainda devolve o mês anterior, e o dashboard mostra os
// KPIs do mês errado.
//
// `getOperationalSummary`, no mesmo ficheiro, já usa `todayInLisbon()` e está
// certo. **As duas metades da mesma página discordam sobre que mês é hoje.**
//
// E o cliente (`financial-dashboard-client.tsx`) constrói a data outra vez,
// agora no fuso do BROWSER, para escrever o rótulo "Mês atual — agosto de 2026".
// São três relógios diferentes a decidir a mesma coisa.
//
// A regra da T15: o domínio recebe `todayCivilDate` de fora e mais nada. Quem
// chama resolve o dia de Lisboa uma vez (`todayInLisbon()`), e a partir daí o
// período é aritmética civil pura. Um teste estático impede qualquer leitura do
// relógio dentro de `src/domain/dashboard`.

import {
  type CivilDate,
  addDays,
  daysInMonth,
  isValidCivilDate,
  partsOf,
  startOfWeek,
} from "../scheduling/civil-date";
import {
  type CivilPeriod,
  dayPeriod,
  makePeriod,
  monthPeriod,
} from "../reports/period";

/** Os períodos que o dashboard apresenta. */
export type DashboardPeriodKind = "today" | "week" | "month" | "year";

export interface DashboardPeriods {
  today: CivilPeriod;
  /** Semana civil de segunda a domingo — a convenção já usada pelo produto. */
  week: CivilPeriod;
  month: CivilPeriod;
  year: CivilPeriod;
  /** Mês anterior, para a comparação mês a mês. */
  previousMonth: CivilPeriod;
  /** Os 12 meses que terminam no mês corrente, do mais antigo para o mais novo. */
  last12Months: CivilPeriod[];
}

/**
 * Constrói todos os períodos do dashboard a partir do dia civil de Lisboa.
 *
 * Devolve `null` — nunca lança, nunca assume "hoje" — quando a data recebida é
 * inválida. Um dashboard que se recusa a desenhar é melhor do que um dashboard
 * que desenha o mês errado.
 */
export function buildDashboardPeriods(todayCivilDate: CivilDate): DashboardPeriods | null {
  if (!isValidCivilDate(todayCivilDate)) return null;

  const { year, month } = partsOf(todayCivilDate);

  const today = dayPeriod(todayCivilDate);
  const month_ = monthPeriod(year, month);
  const yearPeriod = makePeriod(`${String(year).padStart(4, "0")}-01-01`, `${String(year).padStart(4, "0")}-12-31`);
  if (!today || !month_ || !yearPeriod) return null;

  // Semana de segunda a domingo, pela MESMA função que o motor de recorrência
  // da T07 usa (`startOfWeek` em `civil-date.ts`). A primeira versão repetia
  // aqui o cálculo do recuo até segunda; era idêntico, mas duas
  // implementações da convenção de semana significam que o dashboard e o
  // calendário podiam vir a discordar sobre a que semana pertence um dia.
  const weekStart = startOfWeek(todayCivilDate);
  const week = makePeriod(weekStart, addDays(weekStart, 6));
  if (!week) return null;

  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const previousMonth = monthPeriod(prev.y, prev.m);
  if (!previousMonth) return null;

  const last12Months: CivilPeriod[] = [];
  for (let i = 11; i >= 0; i--) {
    const total = year * 12 + (month - 1) - i;
    const p = monthPeriod(Math.floor(total / 12), (total % 12) + 1);
    if (p) last12Months.push(p);
  }

  return { today, week, month: month_, year: yearPeriod, previousMonth, last12Months };
}

/**
 * Dias do mês já decorridos, contando o próprio dia.
 *
 * Usado pelas projecções. Explícito porque a fórmula actual do dashboard nunca
 * declara se conta o dia corrente, e a resposta muda o número.
 */
export function elapsedDaysInMonth(todayCivilDate: CivilDate): number | null {
  if (!isValidCivilDate(todayCivilDate)) return null;
  return partsOf(todayCivilDate).day;
}

/** Dias totais do mês da data. */
export function totalDaysInMonth(todayCivilDate: CivilDate): number | null {
  if (!isValidCivilDate(todayCivilDate)) return null;
  const { year, month } = partsOf(todayCivilDate);
  return daysInMonth(year, month);
}

/** Dias do ano já decorridos, contando o próprio dia. */
export function elapsedDaysInYear(todayCivilDate: CivilDate): number | null {
  if (!isValidCivilDate(todayCivilDate)) return null;
  const { year } = partsOf(todayCivilDate);
  const jan1 = `${String(year).padStart(4, "0")}-01-01`;
  let days = 1;
  let cursor = jan1;
  while (cursor < todayCivilDate) {
    cursor = addDays(cursor, 1);
    days += 1;
    if (days > 400) return null; // rede de segurança contra datas corrompidas
  }
  return days;
}

/** Dias totais do ano da data (365 ou 366). */
export function totalDaysInYear(todayCivilDate: CivilDate): number | null {
  if (!isValidCivilDate(todayCivilDate)) return null;
  const { year } = partsOf(todayCivilDate);
  return daysInMonth(year, 2) === 29 ? 366 : 365;
}

/**
 * Meses completos já decorridos no ano, **sem contar o mês corrente**.
 *
 * Distinção que a projecção actual não faz: o mês corrente está a meio, e
 * tratá-lo como completo enviesa qualquer média.
 */
export function completedMonthsInYear(todayCivilDate: CivilDate): number | null {
  if (!isValidCivilDate(todayCivilDate)) return null;
  return partsOf(todayCivilDate).month - 1;
}

/** Rótulo estável de um mês, para chaves de série. Não é apresentação. */
export function monthKeyOf(period: CivilPeriod): string {
  return period.start.slice(0, 7);
}
