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

// ─── Sanitização ────────────────────────────────────────────────────────────
//
// 🔴 O TypeScript não é fronteira de segurança de uma Server Action.
//
//    `setPaymentStatus` é invocável por qualquer caller que saiba o endpoint,
//    e os tipos desaparecem na compilação. Um caller forjado envia o que
//    quiser em `id` e em `status` — texto livre, um nome, um NIF, um token.
//    Se o tracer confiar no tipo, esse texto entra nos logs, e os logs são
//    guardados, exportados e lidos por gente que não devia vê-lo.
//
//    Por isso a defesa vive **aqui**, no ponto onde se escreve, e não na
//    assinatura de quem chama. Cada campo é reduzido a uma forma conhecida ou
//    substituído por um marcador fixo. Nunca se regista o valor original de
//    algo que não passou.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Um id só entra se for mesmo um UUID. Caso contrário, marcador fixo. */
function idSeguro(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return UUID.test(v) ? v.toLowerCase() : "INVALID_UUID";
}

/**
 * O estado alvo é um conjunto fechado. Fora dele não se regista o texto — só
 * o facto de ter vindo alguma coisa que não é um estado.
 */
function estadoSeguro(v: string | null | undefined): string {
  return v === "pago" || v === "pendente" ? v : "invalid";
}

/**
 * Um código técnico, não uma mensagem.
 *
 * 🔴 Achatar espaços e truncar a 60 não chega: `slice(60)` de uma mensagem do
 *    Postgres continua a ser 60 caracteres de mensagem do Postgres, e é
 *    precisamente aí que aparecem descrições, valores e nomes. A regra passa a
 *    ser de **forma**: se não parecer um código, não é registado de todo.
 */
function codigoSeguro(v: string | null | undefined): string | null {
  if (!v) return null;
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(v) ? v : "UNCLASSIFIED_CODE";
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
      target: estadoSeguro(input.targetStatus),
      payment: idSeguro(input.paymentId),
      // Resolvido no servidor a partir da sessão — mas passa pela mesma peneira.
      // Uma defesa que só se aplica ao que se desconfia não é uma defesa.
      company: idSeguro(input.companyId),
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
