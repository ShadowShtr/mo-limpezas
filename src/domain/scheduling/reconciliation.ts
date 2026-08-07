// Reconciliação determinística contrato ↔ serviço (Task T09).
//
// ── O problema ──────────────────────────────────────────────────────────────
//
// `reconcileFutureServicesForContract` decide o que apagar comparando datas:
// monta o conjunto de datas válidas do padrão atual e elimina os serviços
// futuros cuja data agendada não está lá. Isso mistura três coisas distintas:
//
//   · a IDENTIDADE da ocorrência (que ocorrência é esta);
//   · o ESTADO atual do serviço (onde está marcada agora);
//   · a PROJEÇÃO do contrato (o que o contrato diz que devia ser).
//
// Consequência direta: um serviço reagendado à mão não corresponde a nenhuma
// data válida e é apagado por engano — a edição da gestora desaparece.
//
// Aqui a decisão passa a ser explícita: para cada ocorrência compara-se
// EXPECTED (o que o contrato projeta) com ACTUAL (o que existe), e o resultado
// é uma decisão nomeada. A função é PURA: não fala com a base, não apaga nada
// e não escreve nada. Quem executa é outra camada, e só depois de o schema da
// T08 existir.

import type { ServiceRecord } from "./occurrence-identity";
import {
  diffProjection,
  type ContractSyncedField,
  type ServiceProjection,
} from "./occurrence-projection";
import type { CivilDate } from "./civil-date";

/** Estados reais de `contracts.status` (migration 005). Não inventar valores. */
export type ContractStatus = "ativo" | "pausado" | "cancelado";

export type ReconciliationDecision =
  /** Não existe serviço para esta ocorrência — criar. */
  | "CREATE"
  /** Existe e diverge do contrato em campos sincronizáveis — atualizar. */
  | "UPDATE_FROM_CONTRACT"
  /** Existe e está conforme — não tocar. */
  | "KEEP"
  /** Existe e foi editado à mão — a sincronização não lhe toca. */
  | "KEEP_EXCEPTION"
  /** Existe cancelado — mantém-se e não é recriado. */
  | "KEEP_CANCELLED"
  /** Existe mas o contrato já não prevê esta ocorrência — pode sair. */
  | "REMOVE_ORPHAN"
  /** A data está em `excluded_dates` — foi apagada de propósito. */
  | "SKIP_EXCLUDED"
  /** Evidência insuficiente ou conflito — decisão humana. */
  | "MANUAL_REVIEW";

export interface ReconciliationItem {
  occurrenceDate: CivilDate;
  decision: ReconciliationDecision;
  reason: string;
  serviceId: string | null;
  /** Campos a atualizar. Só preenchido em `UPDATE_FROM_CONTRACT`. */
  changes: ContractSyncedField[];
}

export interface ReconciliationInput {
  contractStatus: ContractStatus;
  /** O que o contrato projeta, por data canónica. */
  expected: ReadonlyMap<CivilDate, ServiceProjection>;
  /** O que existe, com identidade já resolvida (T08). */
  actual: readonly ServiceRecord[];
  /** Projeção atual gravada de cada serviço, para detetar divergências. */
  actualProjections?: Readonly<Record<string, Partial<ServiceProjection>>>;
  excludedDates?: readonly string[] | null;
}

export interface ReconciliationPlan {
  summary: {
    total: number;
    byDecision: Record<ReconciliationDecision, number>;
    /** Decisões que escrevem alguma coisa. */
    writes: number;
  };
  items: ReconciliationItem[];
}

const EMPTY_BY_DECISION: Record<ReconciliationDecision, number> = {
  CREATE: 0, UPDATE_FROM_CONTRACT: 0, KEEP: 0, KEEP_EXCEPTION: 0,
  KEEP_CANCELLED: 0, REMOVE_ORPHAN: 0, SKIP_EXCLUDED: 0, MANUAL_REVIEW: 0,
};

/** Decisões que resultam em escrita. */
const WRITING: ReadonlySet<ReconciliationDecision> = new Set<ReconciliationDecision>([
  "CREATE", "UPDATE_FROM_CONTRACT", "REMOVE_ORPHAN",
]);

export function isWritingDecision(decision: ReconciliationDecision): boolean {
  return WRITING.has(decision);
}

/** Estados de serviço que representam algo que já aconteceu. */
const CONCLUIDOS: ReadonlySet<string> = new Set(["concluido", "em_curso", "falta", "sem_cobertura"]);

export interface DecideInput {
  occurrenceDate: CivilDate;
  contractStatus: ContractStatus;
  expected: ServiceProjection | null;
  actual: ServiceRecord | null;
  actualProjection?: Partial<ServiceProjection>;
  excluded: boolean;
}

/**
 * Decide o destino de UMA ocorrência.
 *
 * A ordem das verificações é a própria política, e é deliberada:
 *
 *   1. exclusão manual vence sobre tudo — foi uma decisão explícita;
 *   2. o que já aconteceu nunca é tocado;
 *   3. cancelado mantém-se e ocupa a identidade;
 *   4. exceção nunca é sobrescrita;
 *   5. só depois se compara com a projeção do contrato.
 */
export function decideReconciliation(input: DecideInput): ReconciliationItem {
  const { occurrenceDate, expected, actual } = input;
  const base = { occurrenceDate, serviceId: actual?.id ?? null, changes: [] as ContractSyncedField[] };

  if (input.excluded) {
    return {
      ...base,
      decision: "SKIP_EXCLUDED",
      reason: "data em excluded_dates — apagada deliberadamente, nunca recriada",
    };
  }

  // ── nada existe ──
  if (actual === null) {
    if (expected === null) {
      return { ...base, decision: "KEEP", reason: "nada esperado e nada existente" };
    }
    if (input.contractStatus !== "ativo") {
      return {
        ...base,
        decision: "KEEP",
        reason: `contrato ${input.contractStatus} — não gera ocorrências novas`,
      };
    }
    return { ...base, decision: "CREATE", reason: "ocorrência prevista e inexistente" };
  }

  // ── algo existe ──
  if (CONCLUIDOS.has(actual.status)) {
    return {
      ...base,
      decision: "KEEP",
      reason: `serviço ${actual.status} — já aconteceu, a sincronização não lhe toca`,
    };
  }

  if (actual.status === "cancelado") {
    return {
      ...base,
      decision: "KEEP_CANCELLED",
      reason: "cancelado — mantém a identidade e não é recriado",
    };
  }

  if (actual.isException) {
    return {
      ...base,
      decision: "KEEP_EXCEPTION",
      reason: "editado à mão — a sincronização automática não sobrescreve",
    };
  }

  if (expected === null) {
    return {
      ...base,
      decision: "REMOVE_ORPHAN",
      reason: "o contrato já não prevê esta ocorrência e o serviço não foi tocado",
    };
  }

  const changes = diffProjection(expected, input.actualProjection ?? {});
  if (changes.length > 0) {
    return {
      ...base,
      decision: "UPDATE_FROM_CONTRACT",
      reason: `diverge do contrato em: ${changes.join(", ")}`,
      changes,
    };
  }

  return { ...base, decision: "KEEP", reason: "conforme com o contrato" };
}

/**
 * Plano completo para um contrato numa janela.
 *
 * Determinístico: a mesma entrada dá sempre o mesmo plano, na mesma ordem.
 * Não escreve nada — devolve intenções.
 */
export function reconcileContract(input: ReconciliationInput): ReconciliationPlan {
  const excluded = new Set(input.excludedDates ?? []);
  const projections = input.actualProjections ?? {};

  // Indexar o existente pela identidade (T08). Serviços sem identidade não
  // participam: pertencem a linhas anteriores ao backfill e nada aqui deve
  // decidir por eles.
  const porOcorrencia = new Map<CivilDate, ServiceRecord[]>();
  for (const service of input.actual) {
    if (service.occurrenceDate === null) continue;
    const lista = porOcorrencia.get(service.occurrenceDate) ?? [];
    lista.push(service);
    porOcorrencia.set(service.occurrenceDate, lista);
  }

  const datas = new Set<CivilDate>([...input.expected.keys(), ...porOcorrencia.keys()]);
  const items: ReconciliationItem[] = [];

  for (const occurrenceDate of [...datas].sort()) {
    const existentes = porOcorrencia.get(occurrenceDate) ?? [];

    // Mais do que um serviço para a mesma identidade só acontece em dados
    // anteriores à constraint da T08. Nunca resolver isso automaticamente.
    if (existentes.length > 1) {
      items.push({
        occurrenceDate,
        decision: "MANUAL_REVIEW",
        reason: `${existentes.length} serviços com a mesma identidade`,
        serviceId: null,
        changes: [],
      });
      continue;
    }

    items.push(decideReconciliation({
      occurrenceDate,
      contractStatus: input.contractStatus,
      expected: input.expected.get(occurrenceDate) ?? null,
      actual: existentes[0] ?? null,
      actualProjection: existentes[0] ? projections[existentes[0].id] : undefined,
      excluded: excluded.has(occurrenceDate),
    }));
  }

  const byDecision = { ...EMPTY_BY_DECISION };
  for (const item of items) byDecision[item.decision]++;

  return {
    summary: {
      total: items.length,
      byDecision,
      writes: items.filter((i) => isWritingDecision(i.decision)).length,
    },
    items,
  };
}

// ─── resultado estruturado da execução ──────────────────────────────────────

/**
 * Resultado de uma sincronização, para quem a executar não poder engolir
 * falhas em silêncio.
 *
 * O código atual tem caminhos em que um `INSERT` falhado apenas continua o
 * ciclo — a ocorrência desaparece sem ninguém saber. Um resultado com
 * `failed` obriga o chamador a olhar.
 */
export interface SyncOutcome {
  created: number;
  updated: number;
  kept: number;
  removed: number;
  skipped: number;
  manualReview: number;
  failed: Array<{ occurrenceDate: CivilDate; code: SyncErrorCode; detail: string }>;
}

export type SyncErrorCode =
  | "INSERT_FAILED"
  | "UPDATE_FAILED"
  | "DELETE_FAILED"
  | "IDENTITY_CONFLICT"
  | "REFERENCE_EXHAUSTED"
  | "UNKNOWN";

export function emptyOutcome(): SyncOutcome {
  return { created: 0, updated: 0, kept: 0, removed: 0, skipped: 0, manualReview: 0, failed: [] };
}

/** A sincronização correu sem nenhuma falha? */
export function isCleanOutcome(outcome: SyncOutcome): boolean {
  return outcome.failed.length === 0;
}

/** Contagens esperadas de um plano, para comparar com o que a execução fez. */
export function expectedOutcome(plan: ReconciliationPlan): Omit<SyncOutcome, "failed"> {
  const d = plan.summary.byDecision;
  return {
    created: d.CREATE,
    updated: d.UPDATE_FROM_CONTRACT,
    kept: d.KEEP + d.KEEP_EXCEPTION + d.KEEP_CANCELLED,
    removed: d.REMOVE_ORPHAN,
    skipped: d.SKIP_EXCLUDED,
    manualReview: d.MANUAL_REVIEW,
  };
}
