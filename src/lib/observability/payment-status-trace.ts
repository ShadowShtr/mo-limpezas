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

import type { AuthGuardCode } from "@/lib/auth-guard";
import type { MotivoFalha } from "@/lib/finance-rpc/payment-cashflow";

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

// Um código técnico, não uma mensagem.
//
// 🔴 Uma allowlist de FORMATO não é uma allowlist.
//
//    `slice(60)` de uma mensagem do Postgres é 60 caracteres de mensagem do
//    Postgres — isso já tinha sido corrigido. Mas o que o substituiu,
//    `/^[A-Za-z0-9_.:-]{1,48}$/`, só verifica que o valor **parece** um
//    código. E parecer um código não custa nada:
//
//        IBAN123456789        passa
//        CustomerName123      passa
//        SecretTokenABC       passa
//
//    Nenhum destes é um código deste domínio, e qualquer um deles entrava nos
//    logs inteiro. Um `code` que venha de um caller forjado, ou de uma
//    biblioteca a devolver algo que não previmos, não tem nada que se pareça
//    com os treze valores que este sistema emite de verdade.
//
//    A regra passa a ser de VALOR: ou o código está no conjunto fechado
//    abaixo, ou não é o valor original que se regista — é `UNCLASSIFIED_CODE`.
//    O valor desconhecido nunca é preservado, nem truncado, nem sanitizado
//    para caber: perde-se, que é o ponto.

/**
 * Os códigos que `setPaymentStatus` emite hoje, mapeados a partir dos callers
 * reais e não de uma leitura optimista do tipo.
 *
 * 🔴 Manter esta lista sincronizada não pode depender de alguém se lembrar.
 *    Duas das quatro origens são tipadas, e por isso o compilador toma conta
 *    delas: ver `_CODIGOS_COBREM_*` no fim do bloco. As outras duas — as
 *    guardas de período, cujo `code` é `string` — são cobertas pelo teste
 *    `payment-status-code-allowlist`, que varre os literais nos ficheiros de
 *    origem e falha se aparecer um que não esteja aqui.
 */
export const CODIGOS_CONHECIDOS = [
  // src/lib/auth-guard.ts — AUTH_GUARD_CODES
  "UNAUTHENTICATED",
  "PROFILE_NOT_FOUND",
  "FORBIDDEN",
  // Identidade estrita: distinguem-se de PROFILE_NOT_FOUND porque exigem
  // respostas diferentes — uma leitura falhada pede retry, uma conta ligada a
  // dois perfis pede intervenção humana, e nenhuma das duas é "não existe".
  "IDENTITY_LOOKUP_FAILED",
  "IDENTITY_AMBIGUOUS",
  // src/lib/finance-period-guard.ts — assertFinancialPeriodOpen
  "INVALID_DATE",
  "FINANCIAL_PERIOD_STATE_UNKNOWN",
  // src/lib/finance-rpc/payment-cashflow.ts — ERRO_PERIODO_FECHADO
  "FINANCIAL_PERIOD_CLOSED",
  // src/app/actions/payments.ts — bloquearSePagamentoEmPeriodoFechado
  "PAYMENT_NOT_FOUND",
  // src/lib/finance-rpc/payment-cashflow.ts — MotivoFalha
  "argumentosInvalidos",
  "rpcEmFalta",
  "periodoFechado",
  "recusadoPelaBase",
  "respostaInesperada",
  // src/app/actions/payments.ts — o catch de topo
  "UNEXPECTED_EXCEPTION",
] as const;

type CodigoConhecido = (typeof CODIGOS_CONHECIDOS)[number];

// ── Guardas de compilação ───────────────────────────────────────────────────
//
// 🔴 Um `AuthGuardCode` ou um `MotivoFalha` novo passa a partir a compilação
//    em vez de aparecer nos logs como `UNCLASSIFIED_CODE` e ninguém perceber
//    porquê. É o único mecanismo aqui que não depende de vigilância humana.
//
//    Os dois imports são `import type` de propósito: `auth-guard` arrasta o
//    cliente service-role e `next/headers`, e este módulo é um sink de logs —
//    não pode ganhar dependências de servidor por causa de uma verificação
//    que desaparece na compilação.
// 🔴 `[Origem] extends [CodigoConhecido]`, e nao `Origem extends ...`.
//
//    Um condicional sobre um parametro de tipo nu DISTRIBUI pela uniao:
//    `Cobre<"A" | "B">` avalia `Cobre<"A"> | Cobre<"B">`, e `true | never`
//    colapsa em `true`. A guarda passava desde que UM dos membros estivesse
//    coberto — ou seja, nunca falhava quando se acrescentava um codigo novo,
//    que e exactamente o unico caso para que existe. As parentesis rectas
//    tiram a distribuicao e obrigam a uniao inteira a caber.
type Cobre<Origem extends string> = [Origem] extends [CodigoConhecido] ? true : never;

const _CODIGOS_COBREM_AUTH_GUARD: Cobre<AuthGuardCode> = true;
const _CODIGOS_COBREM_MOTIVO_RPC: Cobre<MotivoFalha> = true;
void _CODIGOS_COBREM_AUTH_GUARD;
void _CODIGOS_COBREM_MOTIVO_RPC;

const CONJUNTO_CONHECIDO: ReadonlySet<string> = new Set(CODIGOS_CONHECIDOS);

function codigoSeguro(v: string | null | undefined): string | null {
  if (!v) return null;
  return CONJUNTO_CONHECIDO.has(v) ? v : "UNCLASSIFIED_CODE";
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
      // 🔴 No AUTH_GUARD não se regista pagamento nenhum, venha o que vier.
      //
      //    Nesta etapa `requireProfile` ainda não passou: não há sessão
      //    confirmada, não há empresa resolvida, e o `id` é literalmente o que
      //    o caller enviou. Registá-lo é registar entrada não autenticada — e
      //    um UUID válido mas forjado passa por `idSeguro()` sem ficar mais
      //    seguro por isso, porque a forma nunca disse nada sobre a origem.
      //
      //    A garantia vive no SINK e não em cada caller. Uma regra que depende
      //    de quem chama se lembrar dela é uma regra que já falhou uma vez —
      //    aqui não há forma de a esquecer, nem de a contornar por engano.
      //
      //    UNAUTHENTICATED_INPUT_ID_LOGGED = NO
      payment: input.stage === "PAYMENT_STATUS_AUTH_GUARD"
        ? null
        : idSeguro(input.paymentId),
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
