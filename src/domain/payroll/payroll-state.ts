// ============================================================================
// FOLHA DE PAGAMENTO — a máquina de estados
// ============================================================================
//
// Regra pura, sem Supabase, sem React, sem relógio. Existe porque o estado de
// uma folha era, até aqui, apenas um texto numa coluna: quem escrevia
// `status: "aprovado"` conseguia fazê-lo a partir de qualquer estado, e o
// recálculo mensal reescrevia valores de linhas já pagas mantendo o `status`
// intacto.
//
// O dano concreto que isso permitia:
//
//     folha PAGA com €1.200  →  saída de caixa de €1.200 já registada
//     recálculo do mês       →  folha passa a €1.250, continua "pago"
//     resultado              →  a folha diz 1.250, o caixa diz 1.200
//
// Ninguém mentiu; ninguém foi avisado. É esse silêncio que este módulo fecha.
//
// ---------------------------------------------------------------------------
// O contrato
// ---------------------------------------------------------------------------
//
//     RASCUNHO ──aprovar──▶ APROVADO ──pagar──▶ PAGO
//        │                     │                  │
//        │                     └── aprovar = noop │
//        │                                        └── pagar = noop
//        └── economicamente mutável (recalcular, ajustar)
//
// Só RASCUNHO é economicamente mutável. APROVADO e PAGO são fotografias: o
// valor foi fixado por uma decisão humana, e a partir daí só muda por uma ação
// explícita que desfaça essa decisão — nunca por efeito colateral de um
// recálculo ou de um ajuste.
//
// Aprovar um lote que contenha uma linha paga é **recusado por inteiro**, não
// aplicado em parte. Meia operação num lote financeiro é pior do que nenhuma:
// deixa quem clicou sem saber o que ficou feito.
// ============================================================================

/** Os três estados que uma linha de folha pode ter. Espelham a coluna `status`. */
export const PAYROLL_STATUSES = ["rascunho", "aprovado", "pago"] as const;

export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export function isPayrollStatus(value: unknown): value is PayrollStatus {
  return typeof value === "string"
    && (PAYROLL_STATUSES as readonly string[]).includes(value);
}

/**
 * Lê o `status` como vem da base.
 *
 * 🔴 Um valor desconhecido **não** vira `"rascunho"`. Um estado que o domínio
 *    não reconhece é a única situação em que não se sabe o que é seguro fazer,
 *    e assumir o estado mais permissivo é exatamente a troca errada. Devolve
 *    `null`, e quem chama recusa.
 */
export function parsePayrollStatus(value: unknown): PayrollStatus | null {
  return isPayrollStatus(value) ? value : null;
}

// ─── Mutabilidade económica ──────────────────────────────────────────────────

/**
 * Pode esta linha ter os valores em euros alterados?
 *
 * É a pergunta única por trás de recalcular **e** de ajustar manualmente. As
 * duas operações mexem no que se vai pagar a uma pessoa; a diferença é só a
 * origem do número.
 */
export function isEconomicallyMutable(status: PayrollStatus): boolean {
  return status === "rascunho";
}

/** Motivo estável para recusar uma alteração económica. Para decidir, não para mostrar. */
export type PayrollMutationDenial =
  | "APPROVED_IS_IMMUTABLE"
  | "PAID_IS_IMMUTABLE"
  | "UNKNOWN_STATUS";

export function denyEconomicMutation(
  status: PayrollStatus | null,
): PayrollMutationDenial | null {
  if (status === null) return "UNKNOWN_STATUS";
  if (status === "pago") return "PAID_IS_IMMUTABLE";
  if (status === "aprovado") return "APPROVED_IS_IMMUTABLE";
  return null;
}

/** Frase para o ecrã. O código é que decide; isto só explica. */
export const PAYROLL_MUTATION_DENIAL_MESSAGE: Record<PayrollMutationDenial, string> = {
  APPROVED_IS_IMMUTABLE:
    "Esta folha já foi aprovada e não pode ser alterada. Para a corrigir, é preciso primeiro reverter a aprovação.",
  PAID_IS_IMMUTABLE:
    "Esta folha já foi paga e não pode ser alterada. O valor pago está registado no fluxo de caixa.",
  UNKNOWN_STATUS:
    "O estado desta folha não é reconhecido. Nada foi alterado.",
};

// ─── Transição de aprovação ──────────────────────────────────────────────────

/**
 * O que fazer a uma linha quando alguém carrega em "Aprovar".
 *
 * - `apply`  — escrever o novo estado;
 * - `noop`   — já lá está; um segundo clique ou um retry não é um erro;
 * - `denied` — a linha não pode ser aprovada, e o lote inteiro cai.
 */
export type PayrollApproveOutcome =
  | { kind: "apply"; to: PayrollStatus }
  | { kind: "noop" }
  | { kind: "denied"; code: PayrollApproveDenial };

export type PayrollApproveDenial = "PAID_CANNOT_BE_APPROVED" | "UNKNOWN_STATUS";

/**
 * 🔴 `pago → aprovado` é a transição que o código antigo permitia por omissão,
 *    porque nem sequer lia o estado atual antes de escrever. Fazia a folha
 *    recuar para "aprovado" deixando a saída de caixa criada — a linha ficava
 *    a dizer que estava por pagar, com o dinheiro já registado como saído.
 */
export function approveTransition(status: PayrollStatus | null): PayrollApproveOutcome {
  if (status === null) return { kind: "denied", code: "UNKNOWN_STATUS" };
  if (status === "pago") return { kind: "denied", code: "PAID_CANNOT_BE_APPROVED" };
  if (status === "aprovado") return { kind: "noop" };
  return { kind: "apply", to: "aprovado" };
}

export const PAYROLL_APPROVE_DENIAL_MESSAGE: Record<PayrollApproveDenial, string> = {
  PAID_CANNOT_BE_APPROVED:
    "A seleção inclui folhas já pagas, que não podem voltar a aprovado. Nada foi alterado.",
  UNKNOWN_STATUS:
    "A seleção inclui folhas num estado não reconhecido. Nada foi alterado.",
};

// ─── Recálculo ───────────────────────────────────────────────────────────────

/**
 * Decide, linha a linha, se o recálculo mensal lhe pode tocar.
 *
 * `null` é uma linha que ainda não existe para aquele colaborador no período —
 * essa nasce sempre, é o caso normal do primeiro cálculo do mês.
 */
export function canRecalculate(status: PayrollStatus | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return isEconomicallyMutable(status);
}

/**
 * Reparte os colaboradores de um período entre os que o recálculo escreve e os
 * que preserva.
 *
 * Devolver a contagem dos preservados não é cosmético: sem ela a interface
 * dizia "folha recalculada" depois de não ter tocado em metade das linhas, e
 * quem estava a olhar não tinha como saber. Ver §26 do programa de execução.
 */
export function splitRecalculationScope<T>(
  entries: readonly T[],
  statusOf: (entry: T) => PayrollStatus | null | undefined,
): { recalculable: T[]; preserved: T[] } {
  const recalculable: T[] = [];
  const preserved: T[] = [];
  for (const entry of entries) {
    if (canRecalculate(statusOf(entry))) recalculable.push(entry);
    else preserved.push(entry);
  }
  return { recalculable, preserved };
}
