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

/**
 * Códigos que podem ser registados. É uma allowlist FECHADA, não uma sugestão.
 *
 * 🔴 A versão anterior truncava uma string arbitrária a 60 caracteres e
 *    chamava-lhe sanitização. Não é: 60 caracteres do início de uma mensagem
 *    do Postgres chegam para levar o conteúdo de uma linha recusada — uma
 *    descrição, um valor, um IBAN dentro de `detail`. Truncar limita o
 *    tamanho da fuga, não impede a fuga.
 *
 *    Todos os códigos de que este rasto precisa são conhecidos e estáveis:
 *    vêm de `AUTH_GUARD_CODES` (auth-guard.ts) e de `MotivoFalha`
 *    (finance-rpc/payment-cashflow.ts), ambos uniões fechadas. O que não
 *    estiver nesta lista não é encurtado — é substituído.
 */
export const PAYMENT_STATUS_CODES = [
  // auth-guard.ts → AuthGuardCode
  "UNAUTHENTICATED",
  "PROFILE_NOT_FOUND",
  "FORBIDDEN",
  // finance-rpc/payment-cashflow.ts → MotivoFalha
  "argumentosInvalidos",
  "rpcEmFalta",
  "periodoFechado",
  "recusadoPelaBase",
  "respostaInesperada",
  // guarda de período da própria action
  "FINANCIAL_PERIOD_CLOSED",
  // excepção não prevista
  "UNEXPECTED_EXCEPTION",
] as const;

export type PaymentStatusCode = (typeof PAYMENT_STATUS_CODES)[number];

/** Substituto para qualquer entrada fora da allowlist. Nunca o valor original. */
export const CODIGO_DESCONHECIDO = "UNKNOWN_CODE";

/** Substituto para um `targetStatus` que não é um dos dois estados legítimos. */
export const ESTADO_INVALIDO = "invalid";

export interface PaymentStatusTraceInput {
  stage: PaymentStatusStage;
  /** Gerado internamente por `novoCorrelationId` — nunca vindo do cliente. */
  correlationId: string;
  /** Só "pago" ou "pendente" sobrevivem; tudo o resto vira `invalid`. */
  targetStatus: string;
  /** Só é registado se for um UUID válido — vem do cliente. */
  paymentId?: string | null;
  /** Só quando já resolvido pelo servidor a partir da sessão, e só se UUID. */
  companyId?: string | null;
  /** `guard.code`, `motivo` da RPC, ou código do período. Allowlist fechada. */
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

const CODIGOS = new Set<string>(PAYMENT_STATUS_CODES);

/**
 * Devolve o código se estiver na allowlist; caso contrário `UNKNOWN_CODE`.
 *
 * 🔴 Nunca devolve parte do valor original. Saber QUE chegou um código
 *    inesperado é informação de diagnóstico; saber QUAL era o texto é uma
 *    fuga, porque o texto pode ser uma mensagem de base de dados com dados de
 *    negócio lá dentro. Quem precisar do detalhe tem o `stage` e o `cid` para
 *    ir buscá-lo onde ele pode viver.
 */
function codigoSeguro(v: string | null | undefined): PaymentStatusCode | typeof CODIGO_DESCONHECIDO | null {
  if (v === null || v === undefined || v === "") return null;
  return CODIGOS.has(v) ? (v as PaymentStatusCode) : CODIGO_DESCONHECIDO;
}

/**
 * Formato UUID canónico. Um identificador que não seja um UUID não vem do
 * nosso esquema — vem do cliente a tentar outra coisa — e por isso não entra.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Só regista um identificador se for mesmo um UUID.
 *
 * 🔴 `paymentId` chega da chamada do cliente e não é validado antes do guard
 *    de autenticação. Registá-lo em bruto punha no log aquilo que o cliente
 *    quisesse lá pôr: uma credencial, um cabeçalho de sessão, um IBAN.
 *    Um valor que não é UUID não identifica linha nenhuma, portanto não perde
 *    valor de diagnóstico nenhum ao ser descartado.
 */
function idSeguro(v: string | null | undefined): string | null {
  if (!v) return null;
  return UUID.test(v) ? v : null;
}

/** Os dois únicos estados que esta action alcança. Tudo o resto é `invalid`. */
function estadoSeguro(v: string | null | undefined): string {
  return v === "pago" || v === "pendente" ? v : ESTADO_INVALIDO;
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
