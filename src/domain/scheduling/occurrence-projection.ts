// Projeção canónica: contrato + ocorrência → serviço (Task T09).
//
// ── O problema ──────────────────────────────────────────────────────────────
//
// O payload do serviço era montado em DOIS sítios independentes:
//
//   · `generateServicesForContract` (criação/atualização do contrato);
//   · `api/cron/generate-services` (geração mensal).
//
// E os dois discordavam. Diferenças reais medidas no código:
//
//   1. VALOR DE ESTOFOS. A criação usava `unit_value` (quantidade × preço
//      unitário); o cron nem sequer o considerava e caía no valor/hora. Um
//      contrato de estofos ficava com os primeiros meses ao preço certo e os
//      seguintes a um valor diferente.
//
//      A causa de fundo: `unit_value` NÃO É COLUNA NENHUMA — só existia como
//      argumento no momento da criação, calculado no formulário. O cron não
//      tinha como o saber. Aqui é derivado de `upholstery_units` ×
//      `upholstery_unit_price`, que ESTÃO persistidos no contrato, e portanto
//      passa a dar o mesmo resultado nos dois caminhos.
//
//   2. CAMPOS PERDIDOS. O cron não copiava `cleaning_type`, `payment_status`,
//      `upholstery_type`, `upholstery_notes`, `upholstery_units` nem
//      `upholstery_unit_price`. Os serviços dos meses seguintes nasciam sem
//      nada disso — a mesma ocorrência com informação diferente conforme quem
//      a criou.
//
// A partir daqui há uma implementação só. Nenhum consumidor — cron, action,
// calendário ou reparação — deve voltar a montar este payload por sua conta.
//
// Módulo PURO: sem Supabase, sem relógio, sem `process.env`.

import type { ScheduleDay } from "@/types/database";
import { toLisbonTimestamp } from "@/lib/lisbon-time";
import type { CivilDate } from "./civil-date";

/** Campos do contrato que determinam o conteúdo do serviço. */
export interface ContractProjectionFields {
  id: string;
  companyId: string;
  locationId: string;
  /** Avença mensal: o serviço agenda mas não vale nada por si (fatura 1×/mês). */
  fixedMonthly: boolean;
  /** Preço fixo por serviço. */
  fixedPrice: number | null;
  upholsteryType: string | null;
  upholsteryNotes: string | null;
  upholsteryUnits: number | null;
  upholsteryUnitPrice: number | null;
  cleaningType: string | null;
  paymentStatus: string | null;
  applyVat: boolean;
  /** Valor/hora, herdado do local. */
  hourlyRate: number | null;
}

export interface ProjectionInput {
  contract: ContractProjectionFields;
  occurrenceDate: CivilDate;
  schedule: ScheduleDay;
  /** Nº de pessoas da equipa do dia. Ignorado quando não há equipa. */
  teamSize?: number | null;
}

/** Payload determinístico de um serviço de contrato. */
export interface ServiceProjection {
  companyId: string;
  contractId: string;
  locationId: string;
  occurrenceDate: CivilDate;
  scheduledStart: string;
  scheduledEnd: string;
  teamId: string | null;
  numPeople: number;
  hourlyRate: number | null;
  calculatedValue: number | null;
  applyVat: boolean;
  cleaningType: string | null;
  paymentStatus: string | null;
  upholsteryType: string | null;
  upholsteryNotes: string | null;
  upholsteryUnits: number | null;
  upholsteryUnitPrice: number | null;
  status: "agendado";
}

/** Soma minutos a "HH:MM", limitando a 23:59 (nenhuma ocorrência passa do dia). */
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Arredonda a 2 casas como dinheiro, sem devolver `-0` nem `NaN`. */
function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return parseFloat(value.toFixed(2)) + 0;
}

/**
 * Nº de pessoas da ocorrência.
 *
 * Com equipa atribuída, é o tamanho da equipa. Sem equipa, é o `num_people`
 * do dia preenchido à mão. Nunca menos de 1 — um serviço com zero pessoas
 * valeria zero euros em silêncio.
 */
export function resolveNumPeople(schedule: ScheduleDay, teamSize?: number | null): number {
  if (schedule.team_id) {
    return teamSize != null && teamSize >= 1 ? Math.floor(teamSize) : 1;
  }
  const manual = schedule.num_people;
  return manual != null && manual >= 1 ? Math.floor(manual) : 1;
}

/**
 * Total de estofos por unidade: quantidade × preço unitário.
 *
 * Substitui o `unit_value` que só existia no formulário. Os dois fatores estão
 * persistidos no contrato, por isso o cron passa a chegar ao mesmo número que
 * a criação.
 */
export function upholsteryTotal(contract: ContractProjectionFields): number | null {
  const units = contract.upholsteryUnits;
  const price = contract.upholsteryUnitPrice;
  if (units == null || price == null) return null;
  if (!(units > 0) || !(price > 0)) return null;
  return money(units * price);
}

/**
 * Valor da ocorrência, por prioridade:
 *
 *   1. avença mensal → 0 (o serviço agenda; a avença fatura uma vez por mês);
 *   2. preço fixo por serviço;
 *   3. estofos por unidade (quantidade × preço);
 *   4. valor/hora × duração × nº de pessoas;
 *   5. sem base de cálculo → `null` (nunca 0, que se confundiria com avença).
 */
export function projectValue(
  contract: ContractProjectionFields,
  schedule: ScheduleDay,
  numPeople: number,
): number | null {
  if (contract.fixedMonthly) return 0;

  if (contract.fixedPrice != null && contract.fixedPrice > 0) {
    return money(contract.fixedPrice);
  }

  const unidades = upholsteryTotal(contract);
  if (unidades != null) return unidades;

  if (contract.hourlyRate != null) {
    return money((schedule.duration_min / 60) * contract.hourlyRate * numPeople);
  }

  return null;
}

/**
 * Valor/hora a gravar no serviço.
 *
 * Faturação fixa (avença ou preço por serviço) não guarda valor/hora: guardá-lo
 * faria os relatórios recalcularem por hora um serviço que não é por hora.
 */
export function projectHourlyRate(contract: ContractProjectionFields): number | null {
  if (contract.fixedMonthly) return null;
  if (contract.fixedPrice != null && contract.fixedPrice > 0) return null;
  if (upholsteryTotal(contract) != null) return null;
  return contract.hourlyRate;
}

/**
 * Projeta o serviço esperado para uma ocorrência.
 *
 * Determinística: as mesmas entradas dão sempre exatamente o mesmo payload,
 * venha o pedido da criação do contrato, do cron ou da reconciliação.
 */
export function projectOccurrence(input: ProjectionInput): ServiceProjection {
  const { contract, occurrenceDate, schedule } = input;
  const numPeople = resolveNumPeople(schedule, input.teamSize);
  const endTime = addMinutesToTime(schedule.start_time, schedule.duration_min);

  return {
    companyId: contract.companyId,
    contractId: contract.id,
    locationId: contract.locationId,
    occurrenceDate,
    scheduledStart: toLisbonTimestamp(occurrenceDate, schedule.start_time),
    scheduledEnd: toLisbonTimestamp(occurrenceDate, endTime),
    teamId: schedule.team_id || null,
    numPeople,
    hourlyRate: projectHourlyRate(contract),
    calculatedValue: projectValue(contract, schedule, numPeople),
    applyVat: contract.applyVat,
    cleaningType: contract.cleaningType,
    paymentStatus: contract.paymentStatus,
    upholsteryType: contract.upholsteryType,
    upholsteryNotes: contract.upholsteryNotes,
    upholsteryUnits: contract.upholsteryUnits,
    upholsteryUnitPrice: contract.upholsteryUnitPrice,
    status: "agendado",
  };
}

/** Campos que a sincronização do contrato pode reescrever num serviço. */
export const CONTRACT_SYNCED_FIELDS = [
  "scheduledStart", "scheduledEnd", "teamId", "numPeople", "hourlyRate",
  "calculatedValue", "applyVat", "cleaningType", "paymentStatus",
  "upholsteryType", "upholsteryNotes", "upholsteryUnits", "upholsteryUnitPrice",
] as const;

export type ContractSyncedField = (typeof CONTRACT_SYNCED_FIELDS)[number];

/**
 * Diferença entre o que o contrato projeta e o que está gravado.
 *
 * `occurrence_date` NUNCA entra: é identidade, não conteúdo. Comparar
 * identidade com projeção foi precisamente o erro que fez o cron duplicar
 * ocorrências reagendadas (ver T08).
 */
export function diffProjection(
  expected: ServiceProjection,
  actual: Partial<ServiceProjection>,
): ContractSyncedField[] {
  return CONTRACT_SYNCED_FIELDS.filter((field) => {
    const a = expected[field];
    const b = actual[field];
    if (a == null && b == null) return false;
    return a !== b;
  });
}
