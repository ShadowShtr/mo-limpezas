// ============================================================================
// Contrato da RPC de pagamento → caixa (073)
// ============================================================================
//
// 🔴 PREPARADO, NÃO LIGADO.
//
// Nada em `src/app/actions/**` importa este módulo, e há um teste que falha se
// alguém o importar (`payment-cashflow-rpc.test.ts`). `setPaymentStatus`
// continua exactamente como estava.
//
// ---------------------------------------------------------------------------
// Porque é que isto não está ligado
// ---------------------------------------------------------------------------
// As migrations 071, 072 e 073 **não estão aplicadas** em produção. Ligar
// agora obrigaria a uma de duas coisas, e ambas são piores do que esperar:
//
//   · chamar a RPC e ver a aplicação rebentar em produção;
//   · detectar se a função existe e, se não existir, seguir pelo caminho
//     antigo.
//
// A segunda é a tentadora, e é a que fica proibida. Um fallback silencioso
// cria uma **segunda verdade**: a aplicação parece actualizada, mas o
// comportamento passa a depender de um estado escondido da base. Marcar um
// pagamento como pago escreveria numa tabela só — que é exactamente o defeito
// que a 073 existe para corrigir — e ninguém veria diferença nenhuma no ecrã.
// A dívida deixava de ter data de fim, porque deixava de se notar.
//
// Por isso `interpretarErro` trata "a função não existe" como **falha
// fechada**, com uma mensagem que diz o que falta fazer. Não há caminho
// alternativo neste ficheiro. Não deve passar a haver.
//
// ---------------------------------------------------------------------------
// Ordem de activação
// ---------------------------------------------------------------------------
//   1. aplicar 071, 072 e 073 (autorização explícita, nunca por iniciativa);
//   2. confirmar ledger e checksum das três em `public._migrations`;
//   3. correr `npm run rehearse:071`;
//   4. confirmar que as funções existem na base real;
//   5. só então trocar `setPaymentStatus` para chamar `marcarPagamentoPago`.
//
// ⚠️ Nome das funções: o pedido falava em `mark_payment_paid_atomic`. A
//    migration 073 define-as como `mark_payment_paid` / `unmark_payment_paid`.
//    Mantém-se o nome que **está no SQL** — inventar um alias faria a chamada
//    falhar em runtime por uma discrepância que ninguém iria procurar. Se o
//    nome mudar, muda aqui e na 073, e o teste que compara os dois falha até
//    voltarem a bater certo.
// ============================================================================

import { isValidIsoDateString } from "@/lib/utils";
import { validarValorMonetario } from "@/domain/finance-v2/money";

/** Tal e qual como estão declaradas na 073. Uma só fonte para os dois nomes. */
export const RPC_MARCAR_PAGO = "mark_payment_paid" as const;
export const RPC_DESMARCAR_PAGO = "unmark_payment_paid" as const;

/** O erro que a 073 levanta quando o mês já está fechado. */
export const ERRO_PERIODO_FECHADO = "FINANCIAL_PERIOD_CLOSED" as const;

export type ArgumentosMarcarPago = {
  p_company_id: string;
  p_payment_id: string;
  p_paid_on: string;
};

export type ArgumentosDesmarcarPago = {
  p_company_id: string;
  p_payment_id: string;
};

export type ResultadoMarcarPago =
  | {
      ok: true;
      /** `false` na primeira vez, `true` quando a repetição não criou nada. */
      jaEstavaPago: boolean;
      /** O movimento de caixa — o mesmo em todas as repetições. */
      movimentoId: string;
    }
  | { ok: false; error: string; motivo: MotivoFalha };

export type ResultadoDesmarcarPago =
  | { ok: true; movimentosRemovidos: number }
  | { ok: false; error: string; motivo: MotivoFalha };

/**
 * `rpcEmFalta` é o único motivo que **nunca** deve ganhar um caminho
 * alternativo: significa que as migrations não estão aplicadas, e a resposta
 * certa é parar, não escrever pela via antiga.
 */
export type MotivoFalha =
  | "argumentosInvalidos"
  | "rpcEmFalta"
  | "periodoFechado"
  | "recusadoPelaBase"
  | "respostaInesperada";

/**
 * Só o que este módulo precisa de um cliente Supabase.
 *
 * 🔴 `PromiseLike`, e não `Promise`. O `.rpc()` do supabase-js devolve um
 *    *query builder* que é «thenable» mas não é uma `Promise` — exigir
 *    `Promise` fazia o cliente real não caber neste tipo, e a única saída
 *    seria um cast no sítio da chamada. Um cast ali apagaria a verificação
 *    exactamente onde ela vale a pena.
 */
export type ClienteRpc = {
  rpc: (
    nome: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Argumentos ──────────────────────────────────────────────────────────────

export function construirArgumentosMarcarPago(entrada: {
  companyId: string;
  paymentId: string;
  paidOn: string;
}): { ok: true; args: ArgumentosMarcarPago } | { ok: false; error: string } {
  if (!UUID.test(entrada.companyId ?? "")) return { ok: false, error: "Empresa inválida." };
  if (!UUID.test(entrada.paymentId ?? "")) return { ok: false, error: "Pagamento inválido." };

  // 🔴 A mesma validação de data que fechou a corrupção `"72026-01-01"` de
  //    Julho. Uma data malformada aqui iria para a base como data do
  //    movimento de caixa, e o mês inteiro deixava de fechar.
  if (!isValidIsoDateString(entrada.paidOn)) {
    return { ok: false, error: "Data de pagamento inválida." };
  }

  return {
    ok: true,
    args: {
      p_company_id: entrada.companyId,
      p_payment_id: entrada.paymentId,
      p_paid_on: entrada.paidOn,
    },
  };
}

export function construirArgumentosDesmarcarPago(entrada: {
  companyId: string;
  paymentId: string;
}): { ok: true; args: ArgumentosDesmarcarPago } | { ok: false; error: string } {
  if (!UUID.test(entrada.companyId ?? "")) return { ok: false, error: "Empresa inválida." };
  if (!UUID.test(entrada.paymentId ?? "")) return { ok: false, error: "Pagamento inválido." };
  return {
    ok: true,
    args: { p_company_id: entrada.companyId, p_payment_id: entrada.paymentId },
  };
}

// ─── Erros ───────────────────────────────────────────────────────────────────

/**
 * 🔴 Falha fechada, sempre.
 *
 * Nenhum ramo desta função devolve "segue pelo caminho antigo". Ela classifica
 * a falha para que a mensagem seja útil — não para que alguém decida contornar
 * o problema.
 */
export function interpretarErro(erro: { message: string; code?: string }): {
  error: string;
  motivo: MotivoFalha;
} {
  const msg = erro.message ?? "";

  // PostgREST não encontra a função no schema cache; Postgres não a encontra
  // de todo. Os dois querem dizer a mesma coisa: a 073 não está aplicada.
  const emFalta =
    erro.code === "PGRST202" ||
    erro.code === "42883" ||
    /could not find the function|does not exist/i.test(msg);

  if (emFalta) {
    return {
      motivo: "rpcEmFalta",
      error:
        "A operação atómica de pagamento não está disponível nesta base: falta aplicar a migration 073. " +
        "O pagamento não foi alterado — marcá-lo como pago sem criar o movimento de caixa deixaria os " +
        "Custos do mês por baixo do real.",
    };
  }

  if (msg.includes(ERRO_PERIODO_FECHADO)) {
    return {
      motivo: "periodoFechado",
      error: "Este mês está fechado. Reabra o período antes de registar o pagamento.",
    };
  }

  return { motivo: "recusadoPelaBase", error: msg || "A base recusou a operação." };
}

// ─── Leitura da resposta ─────────────────────────────────────────────────────

function primeiraLinha(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return null;
}

export function interpretarRespostaMarcarPago(resposta: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): ResultadoMarcarPago {
  if (resposta.error) return { ok: false, ...interpretarErro(resposta.error) };

  const linha = primeiraLinha(resposta.data);
  const movimento = linha?.cash_entry_id;
  const jaEstava = linha?.ja_estava_pago;

  // A 073 devolve sempre um movimento — é o ponto da operação. Uma resposta
  // sem ele não é sucesso: é uma resposta que não se percebe, e tratá-la como
  // sucesso diria à gestora que o dinheiro foi registado.
  if (typeof movimento !== "string" || typeof jaEstava !== "boolean") {
    return {
      ok: false,
      motivo: "respostaInesperada",
      error: "A base respondeu sem confirmar o movimento de caixa. O pagamento não foi dado como registado.",
    };
  }

  return { ok: true, jaEstavaPago: jaEstava, movimentoId: movimento };
}

export function interpretarRespostaDesmarcarPago(resposta: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): ResultadoDesmarcarPago {
  if (resposta.error) return { ok: false, ...interpretarErro(resposta.error) };

  const linha = primeiraLinha(resposta.data);
  const removidos = linha?.movimentos_removidos;
  if (typeof removidos !== "number" || !Number.isInteger(removidos) || removidos < 0) {
    return {
      ok: false,
      motivo: "respostaInesperada",
      error: "A base respondeu sem dizer o que removeu. A reversão não foi dada como feita.",
    };
  }
  return { ok: true, movimentosRemovidos: removidos };
}

// ─── Chamadas ────────────────────────────────────────────────────────────────

export async function marcarPagamentoPago(
  cliente: ClienteRpc,
  entrada: { companyId: string; paymentId: string; paidOn: string },
): Promise<ResultadoMarcarPago> {
  const args = construirArgumentosMarcarPago(entrada);
  if (!args.ok) return { ok: false, motivo: "argumentosInvalidos", error: args.error };
  return interpretarRespostaMarcarPago(await cliente.rpc(RPC_MARCAR_PAGO, args.args));
}

export async function desmarcarPagamentoPago(
  cliente: ClienteRpc,
  entrada: { companyId: string; paymentId: string },
): Promise<ResultadoDesmarcarPago> {
  const args = construirArgumentosDesmarcarPago(entrada);
  if (!args.ok) return { ok: false, motivo: "argumentosInvalidos", error: args.error };
  return interpretarRespostaDesmarcarPago(await cliente.rpc(RPC_DESMARCAR_PAGO, args.args));
}

// ─── Pré-voo ─────────────────────────────────────────────────────────────────

/**
 * Verifica se um pagamento **pode** gerar um movimento antes de o tentar.
 *
 * Não substitui as validações da 073 — repeti-las em JavaScript seria mentir
 * sobre onde está a garantia. Serve para dar a mensagem certa antes do pedido,
 * em vez de a traduzir de um erro de plpgsql depois.
 */
export function podeGerarMovimento(pagamento: { amount: number | null }): {
  ok: boolean;
  error?: string;
} {
  const v = validarValorMonetario(pagamento.amount, { nome: "O valor do pagamento" });
  if (!v.ok) return { ok: false, error: v.error };
  if (v.valor === null || v.valor <= 0) {
    return { ok: false, error: "Um pagamento sem valor não pode gerar um movimento de caixa." };
  }
  return { ok: true };
}
