// ============================================================================
// CRM — os estados de uma visita comercial
// ============================================================================
//
// 🔴 Sem `"use server"`: são constantes. Ver a nota em `stages.ts`.
//
// Os valores coincidem à letra com o CHECK de `crm_visits.status` na migration
// 102 — `crm-visits.test.ts` verifica-o.
// ============================================================================

export const VISIT_STATUSES = ["agendada", "realizada", "nao_compareceu", "cancelada"] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];

export function isVisitStatus(value: unknown): value is VisitStatus {
  return typeof value === "string" && (VISIT_STATUSES as readonly string[]).includes(value);
}

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  // 🔴 Distinto de "cancelada", e não por gosto de detalhe: quem marca uma
  //    visita e não aparece diz alguma coisa sobre a oportunidade que um
  //    cancelamento combinado não diz.
  nao_compareceu: "Não compareceu",
  cancelada: "Cancelada",
};

export const VISIT_STATUS_COLORS: Record<VisitStatus, string> = {
  agendada: "blue",
  realizada: "green",
  nao_compareceu: "amber",
  cancelada: "slate",
};

/** Uma visita que já não está por acontecer. */
export function isVisitClosed(status: VisitStatus): boolean {
  return status !== "agendada";
}

/**
 * O que cada desfecho exige.
 *
 * Espelha os CHECK da 102: `realizada` sem `completed_at` e `cancelada` sem
 * `cancelled_at` são recusadas pela base. Saber isto aqui permite pedir ou
 * preencher a data antes de gravar, em vez de mostrar um erro de restrição.
 */
export function requiresCompletionDate(status: VisitStatus): boolean {
  return status === "realizada";
}

export function requiresCancellationDate(status: VisitStatus): boolean {
  return status === "cancelada";
}

/**
 * Duração por omissão de uma visita, em minutos.
 *
 * Uma hora é o que uma visita de avaliação costuma levar num condomínio ou
 * escritório. É só o valor inicial do formulário — muda-se a cada marcação.
 */
export const VISIT_DEFAULT_DURATION_MIN = 60;
