// Comparador de recorrência: algoritmo anterior à T07 × motor canónico.
//
// Puro e offline. Não liga ao Supabase, não lê credenciais e não conhece
// nomes, moradas nem qualquer dado pessoal — só campos técnicos de
// recorrência e um identificador opaco escolhido por quem exporta.
//
// Serve para transformar o risco do PR #46 de qualitativo em mensurável:
// em vez de "a paridade pode mudar", responder "mudam estes contratos, nestas
// datas, por esta razão".

import { legacyOccurrencesInRange } from "./legacy-recurrence";
import {
  occurrencesInRange,
  type CivilRange,
  type RecurrenceRule,
} from "./recurrence-engine";
import { isValidCivilDate, partsOf, toEpochDay, type CivilDate } from "./civil-date";

/** Contrato a comparar. `id` é opaco — nunca é interpretado. */
export interface CompatContract extends RecurrenceRule {
  id: string;
}

/**
 * Razões pelas quais a saída mudou. Determinísticas e derivadas da própria
 * diferença, não de suposições.
 */
export type ChangeReason =
  /** Paridade da cadência mudou: baldes da época (fronteira à quinta) → semanas civis. */
  | "WEEK_ANCHOR"
  /** O antigo só gerava no mês de `range.start`; o canónico gera em todos. */
  | "MONTHLY_MULTI_MONTH"
  /** Dia 29/30/31 deixou de transbordar para o mês seguinte. */
  | "MONTHLY_CLAMP"
  /** Ocorrência empurrada de um mês anterior passou a pertencer ao intervalo. */
  | "MONTHLY_LOOKBACK"
  /** O antigo emitia a âncora do mês mesmo fora do intervalo pedido. */
  | "MONTHLY_RANGE_BOUND"
  /** Diferença noutra frequência — não esperada; exige olhar caso a caso. */
  | "UNEXPECTED";

export interface ContractDiff {
  id: string;
  frequency: string;
  startsOn: string;
  endsOn: string | null;
  weekdays: readonly number[] | null;
  intervalDays: number | null;
  window: CivilRange;
  legacy: CivilDate[];
  canonical: CivilDate[];
  /** Datas que o canónico produz e o antigo não produzia. */
  added: CivilDate[];
  /** Datas que o antigo produzia e o canónico já não produz. */
  removed: CivilDate[];
  differenceCount: number;
  changed: boolean;
  reasons: ChangeReason[];
}

export interface CompatSummary {
  totalContracts: number;
  unchanged: number;
  changed: number;
  dailyChanged: number;
  weeklyChanged: number;
  biweeklyChanged: number;
  triweeklyChanged: number;
  monthlyChanged: number;
  customChanged: number;
  otherChanged: number;
  datesAdded: number;
  datesRemoved: number;
  /** Contratos por razão de mudança. */
  byReason: Record<ChangeReason, number>;
  /** Contratos cuja regra é inválida — nenhum dos dois motores gera nada. */
  invalidRules: number;
}

export interface CompatReport {
  window: CivilRange;
  summary: CompatSummary;
  contracts: ContractDiff[];
}

function difference(a: readonly CivilDate[], b: readonly CivilDate[]): CivilDate[] {
  const other = new Set(b);
  return a.filter((d) => !other.has(d));
}

/**
 * Deriva as razões da diferença a partir da evidência, sem adivinhar.
 * Uma diferença pode ter mais do que uma razão.
 */
function deriveReasons(
  rule: RecurrenceRule,
  window: CivilRange,
  legacy: readonly CivilDate[],
  canonical: readonly CivilDate[],
  added: readonly CivilDate[],
  removed: readonly CivilDate[],
): ChangeReason[] {
  const reasons: ChangeReason[] = [];

  if (rule.frequency === "biweekly" || rule.frequency === "triweekly") {
    // A única diferença estrutural nestas frequências é a âncora da semana.
    reasons.push("WEEK_ANCHOR");
    return reasons;
  }

  if (rule.frequency === "monthly") {
    if (canonical.length > legacy.length && added.length > 0) {
      reasons.push("MONTHLY_MULTI_MONTH");
    }
    if (isValidCivilDate(rule.startsOn) && partsOf(rule.startsOn).day > 28) {
      reasons.push("MONTHLY_CLAMP");
    }
    // Data acrescentada que é anterior à âncora do primeiro mês do intervalo:
    // veio da janela de um mês para trás.
    if (added.some((d) => d < window.start || partsOf(d).month !== partsOf(window.start).month)) {
      reasons.push("MONTHLY_LOOKBACK");
    }
    // O antigo emitia algo fora do intervalo pedido e o canónico deixou de o
    // fazer (tolerando o desvio de fim de semana de 2 dias).
    if (removed.some((d) => toEpochDay(d) > toEpochDay(window.end) + 2)) {
      reasons.push("MONTHLY_RANGE_BOUND");
    }
    if (reasons.length === 0) reasons.push("UNEXPECTED");
    return reasons;
  }

  reasons.push("UNEXPECTED");
  return reasons;
}

/** Compara um contrato numa janela. Não altera a entrada. */
export function compareContract(contract: CompatContract, window: CivilRange): ContractDiff {
  const rule: RecurrenceRule = {
    frequency: contract.frequency,
    weekdays: contract.weekdays ?? null,
    intervalDays: contract.intervalDays ?? null,
    startsOn: contract.startsOn,
    endsOn: contract.endsOn ?? null,
    excludedDates: contract.excludedDates ?? null,
  };

  const legacy = legacyOccurrencesInRange(rule, window);
  const canonical = occurrencesInRange(rule, window);
  const added = difference(canonical, legacy);
  const removed = difference(legacy, canonical);
  const changed = added.length > 0 || removed.length > 0;

  return {
    id: contract.id,
    frequency: contract.frequency,
    startsOn: contract.startsOn,
    endsOn: contract.endsOn ?? null,
    weekdays: contract.weekdays ?? null,
    intervalDays: contract.intervalDays ?? null,
    window,
    legacy,
    canonical,
    added,
    removed,
    differenceCount: added.length + removed.length,
    changed,
    reasons: changed ? deriveReasons(rule, window, legacy, canonical, added, removed) : [],
  };
}

const EMPTY_BY_REASON: Record<ChangeReason, number> = {
  WEEK_ANCHOR: 0,
  MONTHLY_MULTI_MONTH: 0,
  MONTHLY_CLAMP: 0,
  MONTHLY_LOOKBACK: 0,
  MONTHLY_RANGE_BOUND: 0,
  UNEXPECTED: 0,
};

/** Compara um conjunto de contratos e resume o impacto. */
export function compareContracts(
  contracts: readonly CompatContract[],
  window: CivilRange,
): CompatReport {
  const diffs = contracts.map((c) => compareContract(c, window));

  const summary: CompatSummary = {
    totalContracts: diffs.length,
    unchanged: 0,
    changed: 0,
    dailyChanged: 0,
    weeklyChanged: 0,
    biweeklyChanged: 0,
    triweeklyChanged: 0,
    monthlyChanged: 0,
    customChanged: 0,
    otherChanged: 0,
    datesAdded: 0,
    datesRemoved: 0,
    byReason: { ...EMPTY_BY_REASON },
    invalidRules: 0,
  };

  const perFrequency: Record<string, keyof CompatSummary> = {
    daily: "dailyChanged",
    weekly: "weeklyChanged",
    biweekly: "biweeklyChanged",
    triweekly: "triweeklyChanged",
    monthly: "monthlyChanged",
    custom: "customChanged",
  };

  for (const diff of diffs) {
    if (!isValidCivilDate(diff.startsOn)) summary.invalidRules++;
    if (!diff.changed) {
      summary.unchanged++;
      continue;
    }
    summary.changed++;
    summary.datesAdded += diff.added.length;
    summary.datesRemoved += diff.removed.length;
    const bucket = perFrequency[diff.frequency] ?? "otherChanged";
    (summary[bucket] as number)++;
    for (const reason of diff.reasons) summary.byReason[reason]++;
  }

  return { window, summary, contracts: diffs };
}

/**
 * Responde à pergunta prática: "um contrato com esta forma muda de datas?"
 *
 * A diferença nas cadências nasce de as duas contagens terem origens
 * distintas: o antigo conta baldes de 7 dias desde a época — e como
 * 1970-01-01 foi uma quinta-feira, a fronteira do balde cai à quinta —
 * enquanto o canónico conta semanas civis desde a segunda-feira. Uma semana
 * civil pode portanto ficar repartida por dois baldes antigos, o que torna o
 * efeito dependente também do dia da semana escolhido.
 *
 * Por isso a resposta é dada por EVIDÊNCIA (correr os dois motores sobre uma
 * janela de prova) e não por álgebra fechada: uma fórmula que ignorasse a
 * repartição por quinta-feira daria respostas erradas em alguns contratos.
 */
/**
 * Segmento da semana a que um dia pertence do ponto de vista do algoritmo
 * antigo. Como a época (1970-01-01) foi uma quinta-feira, os baldes de 7 dias
 * do antigo começavam à QUINTA — logo uma semana civil (segunda a domingo)
 * ficava sempre repartida em dois baldes: segunda–quarta num, quinta–domingo
 * no seguinte.
 */
function legacyWeekSegment(weekday: number): 0 | 1 {
  return weekday >= 1 && weekday <= 3 ? 0 : 1;
}

/**
 * Um contrato quinzenal/3-em-3-semanas muda de paridade **se e só se** o dia
 * escolhido e o dia de início ficarem em lados opostos da fronteira de
 * quinta-feira do algoritmo antigo.
 *
 * Não depende do horário de verão, nem do mês, nem do ano: mover o início uma
 * semana inteira desloca as duas contagens em conjunto. Depende apenas dos
 * dois dias da semana.
 *
 * A fórmula está cruzada com o comparador empírico nos testes — nenhuma das
 * duas é aceite sozinha.
 */
export function cadenceParityShifts(startsOnWeekday: number, chosenWeekday: number): boolean {
  return legacyWeekSegment(startsOnWeekday) !== legacyWeekSegment(chosenWeekday);
}

export function ruleChanges(rule: RecurrenceRule, probeMonths = 12): boolean {
  if (!isValidCivilDate(rule.startsOn)) return false;
  const { year, month, day } = partsOf(rule.startsOn);
  const total = (year * 12 + (month - 1)) + probeMonths;
  const endYear = Math.floor(total / 12);
  const endMonth = (total % 12) + 1;
  const window: CivilRange = {
    start: rule.startsOn,
    end: `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-${String(
      Math.min(day, 28),
    ).padStart(2, "0")}`,
  };
  const diff = compareContract({ id: "probe", ...rule }, window);
  return diff.changed;
}
