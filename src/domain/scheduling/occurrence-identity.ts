// Identidade canónica de uma ocorrência de contrato (Task T08).
//
// ── O problema ──────────────────────────────────────────────────────────────
//
// Hoje a geração decide "já existe?" assim:
//
//     contract_id + scheduled_start dentro do mesmo dia
//
// `scheduled_start` é ESTADO MUTÁVEL. Uma ocorrência pode ser movida de dia,
// ter o horário alterado, mudar de equipa, ser marcada como exceção ou ser
// cancelada. Quando alguém arrasta a visita de quarta para sexta, a data
// canónica de quarta fica sem serviço nenhum — e a corrida seguinte do cron
// cria um serviço NOVO nessa data. Resultado: a mesma ocorrência lógica passa
// a existir duas vezes.
//
// ── A separação que resolve ─────────────────────────────────────────────────
//
// | Conceito | Significado | Muda? |
// |---|---|---|
// | data canónica da ocorrência | "a 5ª visita de agosto deste contrato" | não |
// | `scheduled_start`/`_end` | quando está marcada agora | sim |
// | `is_exception` | divergiu do padrão por decisão humana | sim |
// | `status` | agendado, concluído, cancelado… | sim |
// | `id` do serviço | linha na base | não |
//
// A identidade é a data canónica, não o horário atual.
//
// Este módulo é PURO: define a identidade, classifica serviços existentes e
// decide o que fazer ao garantir uma ocorrência. Não fala com a base.

import { isValidCivilDate, type CivilDate } from "./civil-date";

/**
 * Identidade lógica de uma ocorrência.
 *
 * `companyId` faz parte da identidade de propósito: a unicidade tem de ser
 * por empresa, como todo o resto do modelo multi-empresa.
 */
export interface OccurrenceIdentity {
  companyId: string;
  contractId: string;
  occurrenceDate: CivilDate;
}

/** Estados possíveis de um serviço (espelham o CHECK da migration 006). */
export type ServiceStatus =
  | "agendado" | "em_curso" | "concluido"
  | "cancelado" | "falta" | "sem_cobertura";

/** Serviço tal como é preciso conhecê-lo para raciocinar sobre identidade. */
export interface ServiceRecord {
  id: string;
  companyId: string;
  contractId: string | null;
  /** Coluna nova da T08. `null` enquanto o backfill não correr. */
  occurrenceDate: string | null;
  /** Dia civil em que está agendado agora. */
  scheduledDate: CivilDate;
  status: ServiceStatus;
  isException: boolean;
  /**
   * Coluna que existe desde a migration 006 e que **nenhum código escreve** —
   * é sempre `null` em produção. Não pode servir de base ao backfill; está
   * aqui só para o diagnóstico poder confirmar isso nos dados.
   */
  originalDate: string | null;
  createdAt: string;
}

export function occurrenceKey(identity: OccurrenceIdentity): string {
  return `${identity.companyId}|${identity.contractId}|${identity.occurrenceDate}`;
}

export function sameOccurrence(a: OccurrenceIdentity, b: OccurrenceIdentity): boolean {
  return a.companyId === b.companyId
    && a.contractId === b.contractId
    && a.occurrenceDate === b.occurrenceDate;
}

/** Um serviço já tem identidade explícita? */
export function identityOf(service: ServiceRecord): OccurrenceIdentity | null {
  if (service.contractId === null) return null;
  if (!isValidCivilDate(service.occurrenceDate)) return null;
  return {
    companyId: service.companyId,
    contractId: service.contractId,
    occurrenceDate: service.occurrenceDate,
  };
}

// ─── decisão de idempotência ────────────────────────────────────────────────

/**
 * O que fazer ao garantir uma ocorrência.
 *
 * Nenhuma destas decisões apaga seja o que for: a geração só cria ou não cria.
 */
export type EnsureAction =
  /** Não existe nada para esta identidade — criar. */
  | "CREATE"
  /** Já existe um serviço com esta identidade — não duplicar. */
  | "SKIP_EXISTS"
  /** Existe, foi cancelado. Não recriar automaticamente. */
  | "SKIP_CANCELLED"
  /** Existe e foi editado à mão (exceção). Não sobrescrever. */
  | "SKIP_EXCEPTION"
  /** A data está em `excluded_dates` — foi apagada de propósito. */
  | "SKIP_EXCLUDED"
  /** Mais do que um serviço reclama a mesma identidade — decisão humana. */
  | "CONFLICT_MANUAL";

export interface EnsureDecision {
  action: EnsureAction;
  /** Serviços existentes que reclamam esta identidade. */
  matches: ServiceRecord[];
  reason: string;
}

export interface EnsureInput {
  identity: OccurrenceIdentity;
  /** Serviços já existentes do mesmo contrato (qualquer data). */
  existing: readonly ServiceRecord[];
  /** `contracts.excluded_dates` do contrato. */
  excludedDates?: readonly string[] | null;
}

/**
 * Decide, de forma determinística e sem efeitos, o que fazer com uma
 * ocorrência que se quer garantir.
 *
 * A ordem das verificações é deliberada: uma data excluída à mão nunca deve
 * ser recriada, mesmo que por acaso não exista serviço nenhum — foi
 * precisamente para isso que a exclusão foi registada.
 */
export function decideEnsure(input: EnsureInput): EnsureDecision {
  const { identity, existing } = input;
  const excluded = new Set(input.excludedDates ?? []);

  if (excluded.has(identity.occurrenceDate)) {
    return {
      action: "SKIP_EXCLUDED",
      matches: [],
      reason: "a data está em excluded_dates — foi apagada deliberadamente",
    };
  }

  const matches = existing.filter((s) => {
    const id = identityOf(s);
    return id !== null && sameOccurrence(id, identity);
  });

  if (matches.length === 0) {
    return { action: "CREATE", matches, reason: "não existe serviço com esta identidade" };
  }

  if (matches.length > 1) {
    return {
      action: "CONFLICT_MANUAL",
      matches,
      reason: `${matches.length} serviços reclamam a mesma identidade — exige revisão humana`,
    };
  }

  const [match] = matches;

  if (match.status === "cancelado") {
    return {
      action: "SKIP_CANCELLED",
      matches,
      reason: "a ocorrência foi cancelada — não é recriada automaticamente",
    };
  }

  if (match.isException) {
    return {
      action: "SKIP_EXCEPTION",
      matches,
      reason: "a ocorrência foi editada à mão — a sincronização não a sobrescreve",
    };
  }

  return { action: "SKIP_EXISTS", matches, reason: "a ocorrência já existe" };
}

/** A decisão resulta em escrita? Útil para contar num dry-run. */
export function createsService(action: EnsureAction): boolean {
  return action === "CREATE";
}

// ─── classificação para o backfill ──────────────────────────────────────────

/**
 * Classe de um serviço face à identidade, para o backfill saber o que pode
 * decidir sozinho e o que tem de deixar para revisão.
 */
export type ServiceClass =
  /** Ligado a contrato, agendado na data canónica, sem divergências. */
  | "NORMAL"
  /** Ligado a contrato mas movido/editado — a data agendada não é a canónica. */
  | "RESCHEDULED"
  /** Cancelado. */
  | "CANCELLED"
  /** Parece ser a mesma ocorrência de outro serviço. */
  | "DUPLICATE_CANDIDATE"
  /** Há mais do que uma leitura possível — não adivinhar. */
  | "AMBIGUOUS"
  /** `contract_id` aponta para um contrato que não existe no snapshot. */
  | "MISSING_CONTRACT"
  /** Ligado a contrato mas a data não pertence ao padrão de recorrência. */
  | "DATE_INCONSISTENT"
  /** Serviço avulso, sem contrato — fora do âmbito da identidade. */
  | "STANDALONE";

export interface ClassifyInput {
  service: ServiceRecord;
  /** O contrato existe no snapshot? */
  contractExists: boolean;
  /** Datas canónicas do contrato na janela analisada. */
  canonicalDates: readonly CivilDate[];
  /** Serviços do mesmo contrato, para detetar candidatos a duplicado. */
  siblings: readonly ServiceRecord[];
}

export interface Classification {
  serviceId: string;
  class: ServiceClass;
  /** Identidade proposta — `null` quando não é seguro propor uma. */
  proposedOccurrenceDate: CivilDate | null;
  reason: string;
}

/**
 * Classifica um serviço e propõe (ou recusa propor) a data canónica.
 *
 * Regra de ouro: quando a evidência não chega, devolve `AMBIGUOUS` com
 * proposta `null`. Adivinhar aqui significa reescrever silenciosamente o
 * histórico de um cliente real.
 */
export function classifyService(input: ClassifyInput): Classification {
  const { service, contractExists, canonicalDates, siblings } = input;
  const id = service.id;

  if (service.contractId === null) {
    return {
      serviceId: id,
      class: "STANDALONE",
      proposedOccurrenceDate: null,
      reason: "serviço avulso — continua independente e não recebe identidade",
    };
  }

  if (!contractExists) {
    return {
      serviceId: id,
      class: "MISSING_CONTRACT",
      proposedOccurrenceDate: null,
      reason: "contract_id não corresponde a nenhum contrato do snapshot",
    };
  }

  const canonical = new Set(canonicalDates);
  const onCanonicalDate = canonical.has(service.scheduledDate);

  // Outro serviço do mesmo contrato no mesmo dia agendado.
  const sameDay = siblings.filter(
    (s) => s.id !== id && s.scheduledDate === service.scheduledDate,
  );

  if (service.status === "cancelado") {
    return {
      serviceId: id,
      class: "CANCELLED",
      // Um cancelamento na data canónica mantém a identidade: é essa
      // identidade que impede o cron de recriar a ocorrência.
      proposedOccurrenceDate: onCanonicalDate ? service.scheduledDate : null,
      reason: onCanonicalDate
        ? "cancelado na data canónica — a identidade é preservada"
        : "cancelado fora da data canónica — identidade indeterminada",
    };
  }

  if (sameDay.length > 0) {
    return {
      serviceId: id,
      class: "DUPLICATE_CANDIDATE",
      proposedOccurrenceDate: onCanonicalDate ? service.scheduledDate : null,
      reason: `${sameDay.length + 1} serviços do mesmo contrato no mesmo dia`,
    };
  }

  if (onCanonicalDate && !service.isException) {
    return {
      serviceId: id,
      class: "NORMAL",
      proposedOccurrenceDate: service.scheduledDate,
      reason: "agendado exatamente na data canónica",
    };
  }

  if (onCanonicalDate && service.isException) {
    // Editado (valor, equipa, notas) mas sem sair do dia canónico.
    return {
      serviceId: id,
      class: "NORMAL",
      proposedOccurrenceDate: service.scheduledDate,
      reason: "exceção que continua na data canónica — identidade clara",
    };
  }

  // Fora da data canónica. `original_date` seria a evidência ideal, mas nunca
  // é escrita por código nenhum: se vier preenchida num snapshot real é sinal
  // de origem desconhecida e não deve ser usada às cegas.
  if (service.isException) {
    return {
      serviceId: id,
      class: "RESCHEDULED",
      proposedOccurrenceDate: null,
      reason:
        "exceção fora da data canónica — a data de origem não é recuperável "
        + "(original_date nunca foi preenchida); exige revisão",
    };
  }

  return {
    serviceId: id,
    class: "DATE_INCONSISTENT",
    proposedOccurrenceDate: null,
    reason: "não é exceção mas a data não pertence ao padrão de recorrência atual",
  };
}
