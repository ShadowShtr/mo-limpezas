// ============================================================================
// Rasto de `setPaymentStatus` — porque é que uma marcação não passou
// ============================================================================
//
// Origem: 2026-08-27. Uma tentativa real de marcar um pagamento como pago não
// escreveu nada — nem estado, nem movimento de caixa, nem proveniência. A base
// ficou intacta, o que é o comportamento certo, mas tornou o diagnóstico
// impossível: **uma falha antes da RPC e um rollback integral da RPC deixam
// exactamente o mesmo estado**. Sem rasto, distinguir os dois casos exigia
// repetir a tentativa às cegas em produção.
//
// Este módulo existe para que a próxima falha diga onde parou, sem repetição.
//
// 🔴 O que NUNCA entra numa linha destas:
//    cookies · JWT · Authorization · service-role key · DB URL · password ·
//    descrição do pagamento · anexos · nome/email/telefone · valores de env.
//
//    O que entra são identificadores técnicos e códigos de decisão. O
//    `companyId` só aparece depois de resolvido no servidor a partir da sessão
//    — nunca vindo do cliente — e é o mesmo critério já usado em
//    `route-metrics.ts`, que o trata como metadado de correlação.
//
// 🔴 Isto NÃO altera comportamento. Não converte erro em sucesso, não cria
//    caminho alternativo de escrita, não engole excepções. Falhar continua a
//    falhar, fechado, com a mesma mensagem para quem clicou.
// ============================================================================

/** Onde a operação parou. Cada etapa é distinguível na linha de log. */
export type PaymentStatusStage =
  | "PAYMENT_STATUS_AUTH_GUARD"
  | "PAYMENT_STATUS_PERIOD_GUARD"
  | "PAYMENT_STATUS_MARK_RPC"
  | "PAYMENT_STATUS_UNMARK_GUARD"
  | "PAYMENT_STATUS_UNMARK_RPC"
  | "PAYMENT_STATUS_OK"
  | "PAYMENT_STATUS_UNEXPECTED_EXCEPTION";

export interface PaymentStatusTraceInput {
  stage: PaymentStatusStage;
  correlationId: string;
  targetStatus: string;
  paymentId?: string | null;
  /** Só quando já resolvido pelo servidor a partir da sessão. */
  companyId?: string | null;
  /** `guard.code`, `motivo` da RPC, ou código do período. */
  code?: string | null;
  ok: boolean;
}

/**
 * Identificador curto para correlacionar as etapas de uma mesma tentativa.
 *
 * Não é criptográfico e não precisa de ser: serve para juntar linhas do mesmo
 * clique nos logs, não para autenticar nada.
 */
export function novoCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Trunca e achata um código. Os códigos do projecto são curtos e estáveis
 * (`FORBIDDEN`, `FINANCIAL_PERIOD_CLOSED`, `argumentosInvalidos`), mas uma
 * mensagem de erro do Postgres pode trazer texto arbitrário — e texto
 * arbitrário é onde os dados de negócio se escondem.
 */
function codigoSeguro(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(/\s+/g, " ").slice(0, 60);
}

/**
 * Emite uma linha estruturada. Fire-and-forget: a observabilidade nunca pode
 * partir a operação que observa.
 */
export function tracePaymentStatus(input: PaymentStatusTraceInput): void {
  try {
    const line = {
      t: "payment_status",
      ts: new Date().toISOString(),
      stage: input.stage,
      cid: input.correlationId,
      target: input.targetStatus,
      payment: input.paymentId ?? null,
      company: input.companyId ?? null,
      code: codigoSeguro(input.code),
      ok: input.ok,
    };
    if (input.stage === "PAYMENT_STATUS_UNEXPECTED_EXCEPTION") console.error(JSON.stringify(line));
    else if (!input.ok) console.warn(JSON.stringify(line));
    else console.log(JSON.stringify(line));
  } catch {
    /* nunca partir a request por causa de um log */
  }
}
