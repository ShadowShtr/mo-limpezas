// Diagnóstico e planeamento de reparação de identidade de ocorrências (T08).
//
// Duas funções separadas de propósito:
//
//   diagnose(...)  → o que está mal (só factos)
//   planRepair(...) → o que fazer (só intenções)
//
// Nenhuma das duas escreve seja o que for. A execução real fica para a base
// descartável, com flag própria, e nunca é possível a partir daqui.
//
// Puro e offline: não liga ao Supabase, não lê credenciais, não conhece nomes,
// emails nem moradas.

import { occurrencesInRange, type RecurrenceRule } from "./recurrence-engine";
import type { CivilRange } from "./recurrence-engine";
import { isValidCivilDate, type CivilDate } from "./civil-date";
import {
  classifyService,
  type Classification,
  type ServiceClass,
  type ServiceRecord,
} from "./occurrence-identity";

/** Contrato do snapshot: só campos técnicos. */
export interface ContractRecord extends RecurrenceRule {
  id: string;
  companyId: string;
  status: string;
}

/**
 * Relações de um serviço com o resto do sistema. Determinam se um duplicado
 * pode ser resolvido automaticamente ou se apagar seja o que for destruiria
 * informação.
 *
 * As chaves espelham as FK reais encontradas nas migrations:
 * timesheets (007, CASCADE), service_photos (027, CASCADE),
 * service_reinforcements e service_price_audit (006, CASCADE),
 * invoice_items (008, SET NULL), client_notifications (013, SET NULL).
 */
export interface DependencySignals {
  timesheets: number;
  invoiceItems: number;
  photos: number;
  reinforcements: number;
  notifications: number;
  priceAudits: number;
}

export const NO_DEPENDENCIES: DependencySignals = {
  timesheets: 0, invoiceItems: 0, photos: 0,
  reinforcements: 0, notifications: 0, priceAudits: 0,
};

export interface RepairSnapshot {
  window: CivilRange;
  contracts: readonly ContractRecord[];
  services: readonly ServiceRecord[];
  /** Sinais por `service.id`. Ausente = sem dependências conhecidas. */
  dependencies?: Readonly<Record<string, DependencySignals>>;
}

// ─── diagnóstico ────────────────────────────────────────────────────────────

export interface DuplicateGroup {
  companyId: string;
  contractId: string;
  /** Dia civil em que os serviços colidem. */
  date: CivilDate;
  serviceIds: string[];
}

export interface MissingOccurrence {
  companyId: string;
  contractId: string;
  occurrenceDate: CivilDate;
}

export interface DiagnosisReport {
  window: CivilRange;
  summary: {
    services: number;
    contracts: number;
    byClass: Record<ServiceClass, number>;
    duplicateGroups: number;
    duplicateServices: number;
    missingOccurrences: number;
    servicesWithoutContract: number;
    servicesWithUnknownContract: number;
    /** Serviços em datas que o contrato declara excluídas. */
    excludedButPresent: number;
    /**
     * Serviços com `original_date` preenchida. Nenhum código do projeto
     * escreve esta coluna, por isso o esperado é ZERO; qualquer valor tem
     * origem desconhecida e não deve ser usado pelo backfill.
     */
    originalDatePresent: number;
    /** Ocorrências que o backfill NÃO consegue decidir sozinho. */
    needsManualReview: number;
  };
  classifications: Classification[];
  duplicateGroups: DuplicateGroup[];
  missingOccurrences: MissingOccurrence[];
  excludedButPresent: Array<{ serviceId: string; contractId: string; date: CivilDate }>;
}

const EMPTY_BY_CLASS: Record<ServiceClass, number> = {
  NORMAL: 0, RESCHEDULED: 0, CANCELLED: 0, DUPLICATE_CANDIDATE: 0,
  AMBIGUOUS: 0, MISSING_CONTRACT: 0, DATE_INCONSISTENT: 0, STANDALONE: 0,
};

/** Classes que o backfill não pode resolver sozinho. */
const MANUAL_CLASSES: ReadonlySet<ServiceClass> = new Set<ServiceClass>([
  "RESCHEDULED", "AMBIGUOUS", "DATE_INCONSISTENT", "MISSING_CONTRACT",
]);

export function diagnose(snapshot: RepairSnapshot): DiagnosisReport {
  const contractsById = new Map(snapshot.contracts.map((c) => [c.id, c]));
  const servicesByContract = new Map<string, ServiceRecord[]>();
  for (const service of snapshot.services) {
    if (service.contractId === null) continue;
    const list = servicesByContract.get(service.contractId) ?? [];
    list.push(service);
    servicesByContract.set(service.contractId, list);
  }

  // Datas canónicas por contrato, uma vez só.
  const canonicalByContract = new Map<string, CivilDate[]>();
  for (const contract of snapshot.contracts) {
    canonicalByContract.set(contract.id, occurrencesInRange(contract, snapshot.window));
  }

  const classifications: Classification[] = [];
  const byClass = { ...EMPTY_BY_CLASS };
  let servicesWithoutContract = 0;
  let servicesWithUnknownContract = 0;
  let originalDatePresent = 0;

  for (const service of snapshot.services) {
    if (service.originalDate !== null) originalDatePresent++;
    if (service.contractId === null) servicesWithoutContract++;
    else if (!contractsById.has(service.contractId)) servicesWithUnknownContract++;

    const classification = classifyService({
      service,
      contractExists: service.contractId !== null && contractsById.has(service.contractId),
      canonicalDates: service.contractId ? canonicalByContract.get(service.contractId) ?? [] : [],
      siblings: service.contractId ? servicesByContract.get(service.contractId) ?? [] : [],
    });
    classifications.push(classification);
    byClass[classification.class]++;
  }

  // Grupos de duplicados: mesmo contrato, mesmo dia civil.
  const groups = new Map<string, DuplicateGroup>();
  for (const [contractId, services] of servicesByContract) {
    const byDate = new Map<CivilDate, ServiceRecord[]>();
    for (const service of services) {
      const list = byDate.get(service.scheduledDate) ?? [];
      list.push(service);
      byDate.set(service.scheduledDate, list);
    }
    for (const [date, list] of byDate) {
      if (list.length < 2) continue;
      groups.set(`${contractId}|${date}`, {
        companyId: list[0].companyId,
        contractId,
        date,
        serviceIds: [...list].map((s) => s.id).sort(),
      });
    }
  }
  const duplicateGroups = [...groups.values()].sort((a, b) =>
    a.contractId === b.contractId ? a.date.localeCompare(b.date) : a.contractId.localeCompare(b.contractId),
  );

  // Ocorrências canónicas sem serviço nenhum, e serviços em datas excluídas.
  const missingOccurrences: MissingOccurrence[] = [];
  const excludedButPresent: DiagnosisReport["excludedButPresent"] = [];
  for (const contract of snapshot.contracts) {
    const services = servicesByContract.get(contract.id) ?? [];
    const scheduled = new Set(services.map((s) => s.scheduledDate));
    const excluded = new Set(contract.excludedDates ?? []);
    for (const date of canonicalByContract.get(contract.id) ?? []) {
      if (!scheduled.has(date) && !excluded.has(date)) {
        missingOccurrences.push({
          companyId: contract.companyId,
          contractId: contract.id,
          occurrenceDate: date,
        });
      }
    }
    for (const service of services) {
      if (excluded.has(service.scheduledDate)) {
        excludedButPresent.push({
          serviceId: service.id,
          contractId: contract.id,
          date: service.scheduledDate,
        });
      }
    }
  }

  const needsManualReview = classifications.filter((c) => MANUAL_CLASSES.has(c.class)).length;

  return {
    window: snapshot.window,
    summary: {
      services: snapshot.services.length,
      contracts: snapshot.contracts.length,
      byClass,
      duplicateGroups: duplicateGroups.length,
      duplicateServices: duplicateGroups.reduce((n, g) => n + g.serviceIds.length, 0),
      missingOccurrences: missingOccurrences.length,
      servicesWithoutContract,
      servicesWithUnknownContract,
      excludedButPresent: excludedButPresent.length,
      originalDatePresent,
      needsManualReview,
    },
    classifications,
    duplicateGroups,
    missingOccurrences,
    excludedButPresent,
  };
}

// ─── planeamento da reparação ───────────────────────────────────────────────

export type RepairActionType =
  /** Preencher `occurrence_date` com uma data segura. */
  | "SET_OCCURRENCE_DATE"
  /** Manter o serviço como está (sobrevivente de um duplicado). */
  | "KEEP_SERVICE"
  /** Ligar um serviço a uma identidade já existente. */
  | "LINK_OCCURRENCE"
  /** Candidato a fundir/remover — nunca executado por este planeador. */
  | "DEDUPLICATE_CANDIDATE"
  /** Registar que a ocorrência não deve ser recriada pelo cron. */
  | "DO_NOT_RECREATE"
  /** Evidência insuficiente. */
  | "MARK_AMBIGUOUS"
  /** Conflito real de dados — decisão humana obrigatória. */
  | "MANUAL_REVIEW";

export interface RepairAction {
  type: RepairActionType;
  serviceId: string | null;
  contractId: string | null;
  occurrenceDate: CivilDate | null;
  reason: string;
  /** Só em duplicados: é seguro fundir automaticamente? */
  safety?: "SAFE_TO_MERGE" | "MANUAL_REVIEW";
}

export interface RepairPlan {
  window: CivilRange;
  summary: {
    total: number;
    byType: Record<RepairActionType, number>;
    safeToMerge: number;
    manualReview: number;
  };
  actions: RepairAction[];
}

const STATUS_WEIGHT: Record<string, number> = {
  concluido: 5, em_curso: 4, agendado: 3, falta: 2, sem_cobertura: 1, cancelado: 0,
};

/** Dependências que representam trabalho ou dinheiro reais. */
function hasHardDependencies(deps: DependencySignals): boolean {
  return deps.timesheets > 0 || deps.invoiceItems > 0;
}

function dependencyWeight(deps: DependencySignals): number {
  return deps.timesheets * 1000 + deps.invoiceItems * 1000
    + deps.photos * 10 + deps.reinforcements * 10
    + deps.priceAudits + deps.notifications;
}

/**
 * Escolhe o sobrevivente de um grupo de duplicados, de forma determinística.
 *
 * Nunca "o primeiro id": a ordem de chegada não diz nada sobre qual serviço
 * tem o trabalho real associado. A ordem é por evidência — estado, trabalho
 * registado, dinheiro, anexos — e só depois por antiguidade. O `id` entra
 * apenas como desempate final, para o resultado ser reprodutível.
 */
export function chooseSurvivor(
  services: readonly ServiceRecord[],
  dependencies: Readonly<Record<string, DependencySignals>> = {},
): { survivor: ServiceRecord; safety: "SAFE_TO_MERGE" | "MANUAL_REVIEW"; reason: string } {
  const scored = [...services].sort((a, b) => {
    const depA = dependencies[a.id] ?? NO_DEPENDENCIES;
    const depB = dependencies[b.id] ?? NO_DEPENDENCIES;
    const byDeps = dependencyWeight(depB) - dependencyWeight(depA);
    if (byDeps !== 0) return byDeps;
    const byStatus = (STATUS_WEIGHT[b.status] ?? 0) - (STATUS_WEIGHT[a.status] ?? 0);
    if (byStatus !== 0) return byStatus;
    const byException = Number(b.isException) - Number(a.isException);
    if (byException !== 0) return byException;
    const byAge = a.createdAt.localeCompare(b.createdAt);
    if (byAge !== 0) return byAge;
    return a.id.localeCompare(b.id);
  });

  const survivor = scored[0];
  const others = scored.slice(1);

  // Se mais do que um lado tem trabalho ou dinheiro registado, fundir apagaria
  // informação real. Nunca decidir isso automaticamente.
  const withHard = services.filter((s) => hasHardDependencies(dependencies[s.id] ?? NO_DEPENDENCIES));
  if (withHard.length > 1) {
    return {
      survivor,
      safety: "MANUAL_REVIEW",
      reason: `${withHard.length} serviços têm registo de ponto ou linha de fatura — fundir destruiria dados`,
    };
  }

  const othersWithAnything = others.filter(
    (s) => dependencyWeight(dependencies[s.id] ?? NO_DEPENDENCIES) > 0,
  );
  if (othersWithAnything.length > 0) {
    return {
      survivor,
      safety: "MANUAL_REVIEW",
      reason: "um duplicado não sobrevivente tem dependências associadas",
    };
  }

  return {
    survivor,
    safety: "SAFE_TO_MERGE",
    reason: "só o sobrevivente tem dependências (ou nenhum tem)",
  };
}

const EMPTY_BY_TYPE: Record<RepairActionType, number> = {
  SET_OCCURRENCE_DATE: 0, KEEP_SERVICE: 0, LINK_OCCURRENCE: 0,
  DEDUPLICATE_CANDIDATE: 0, DO_NOT_RECREATE: 0, MARK_AMBIGUOUS: 0, MANUAL_REVIEW: 0,
};

/**
 * Produz um plano a partir do diagnóstico. Não altera nada e não gera nenhum
 * `DELETE`: os duplicados saem como candidatos, com um veredicto de segurança.
 */
export function planRepair(
  diagnosis: DiagnosisReport,
  snapshot: RepairSnapshot,
): RepairPlan {
  const servicesById = new Map(snapshot.services.map((s) => [s.id, s]));
  const dependencies = snapshot.dependencies ?? {};
  const actions: RepairAction[] = [];
  const inDuplicateGroup = new Set(diagnosis.duplicateGroups.flatMap((g) => g.serviceIds));

  for (const classification of diagnosis.classifications) {
    const service = servicesById.get(classification.serviceId);
    if (!service) continue;
    if (classification.class === "STANDALONE") continue;
    if (inDuplicateGroup.has(service.id)) continue; // tratado no bloco dos duplicados

    if (classification.class === "CANCELLED" && classification.proposedOccurrenceDate) {
      actions.push({
        type: "DO_NOT_RECREATE",
        serviceId: service.id,
        contractId: service.contractId,
        occurrenceDate: classification.proposedOccurrenceDate,
        reason: "cancelado na data canónica — a identidade impede a recriação pelo cron",
      });
      continue;
    }

    if (classification.proposedOccurrenceDate !== null) {
      actions.push({
        type: "SET_OCCURRENCE_DATE",
        serviceId: service.id,
        contractId: service.contractId,
        occurrenceDate: classification.proposedOccurrenceDate,
        reason: classification.reason,
      });
      continue;
    }

    actions.push({
      type: classification.class === "MISSING_CONTRACT" ? "MANUAL_REVIEW" : "MARK_AMBIGUOUS",
      serviceId: service.id,
      contractId: service.contractId,
      occurrenceDate: null,
      reason: classification.reason,
    });
  }

  for (const group of diagnosis.duplicateGroups) {
    const services = group.serviceIds
      .map((id) => servicesById.get(id))
      .filter((s): s is ServiceRecord => s !== undefined);
    if (services.length === 0) continue;

    const { survivor, safety, reason } = chooseSurvivor(services, dependencies);

    actions.push({
      type: "KEEP_SERVICE",
      serviceId: survivor.id,
      contractId: group.contractId,
      occurrenceDate: group.date,
      reason: `sobrevivente escolhido: ${reason}`,
      safety,
    });

    for (const other of services) {
      if (other.id === survivor.id) continue;
      actions.push({
        type: safety === "SAFE_TO_MERGE" ? "DEDUPLICATE_CANDIDATE" : "MANUAL_REVIEW",
        serviceId: other.id,
        contractId: group.contractId,
        occurrenceDate: group.date,
        reason: safety === "SAFE_TO_MERGE"
          ? "duplicado sem dependências — candidato a remoção, sujeito a confirmação humana"
          : reason,
        safety,
      });
    }
  }

  for (const missing of diagnosis.missingOccurrences) {
    actions.push({
      type: "LINK_OCCURRENCE",
      serviceId: null,
      contractId: missing.contractId,
      occurrenceDate: missing.occurrenceDate,
      reason: "ocorrência canónica sem serviço — será criada pela geração idempotente",
    });
  }

  const byType = { ...EMPTY_BY_TYPE };
  for (const action of actions) byType[action.type]++;

  // Ordem determinística: a mesma entrada dá sempre o mesmo plano.
  actions.sort((a, b) =>
    (a.contractId ?? "").localeCompare(b.contractId ?? "")
    || (a.occurrenceDate ?? "").localeCompare(b.occurrenceDate ?? "")
    || a.type.localeCompare(b.type)
    || (a.serviceId ?? "").localeCompare(b.serviceId ?? ""));

  return {
    window: diagnosis.window,
    summary: {
      total: actions.length,
      byType,
      safeToMerge: actions.filter((a) => a.safety === "SAFE_TO_MERGE").length,
      manualReview: actions.filter((a) => a.type === "MANUAL_REVIEW" || a.type === "MARK_AMBIGUOUS").length,
    },
    actions,
  };
}

/** Valida um snapshot antes de o usar — falha cedo em vez de produzir lixo. */
export function validateSnapshot(snapshot: RepairSnapshot): string[] {
  const problems: string[] = [];
  if (!isValidCivilDate(snapshot.window?.start) || !isValidCivilDate(snapshot.window?.end)) {
    problems.push("janela inválida: start/end têm de ser datas YYYY-MM-DD");
  }
  for (const service of snapshot.services) {
    if (!isValidCivilDate(service.scheduledDate)) {
      problems.push(`serviço ${service.id}: scheduledDate inválida`);
    }
  }
  for (const contract of snapshot.contracts) {
    if (!isValidCivilDate(contract.startsOn)) {
      problems.push(`contrato ${contract.id}: startsOn inválido`);
    }
  }
  return problems;
}
