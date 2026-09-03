// Leitura fail-closed do que as RPCs atómicas do período financeiro devolvem.
//
// Uma RPC `RETURNS TABLE (...)` chega ao supabase-js como um array de linhas.
// Ignorar esse retorno — `const { error } = await admin.rpc(...)` — custa duas
// coisas de uma vez:
//
//   · a auditoria fica sem os identificadores que só a transação conhece (o
//     `cash_flow_entries.id` que ela criou, o `match` que ela ligou), e passa a
//     apontar para o que o TypeScript tinha à mão — que é outra entidade;
//   · o valor económico volta a ser recalculado deste lado, o que é a segunda
//     fonte da mesma regra que estas migrations vieram fechar.
//
// Daí estes leitores. Uma forma inesperada NÃO é tratada como sucesso: se a
// resposta não é exatamente a esperada, quem chamou não sabe o que ficou
// gravado, e declarar sucesso nesse estado é pior do que falhar.

export type RpcRead<T> = ({ ok: true } & T) | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uma e uma só linha. Zero linhas significa que a RPC não escreveu nada. */
function unicaLinha(linhas: unknown): Record<string, unknown> | null {
  if (!Array.isArray(linhas) || linhas.length !== 1) return null;
  const linha = linhas[0];
  return linha !== null && typeof linha === "object" ? linha as Record<string, unknown> : null;
}

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}

/**
 * `numeric` do Postgres chega como string ou número conforme o driver. Ambos
 * servem; o que não serve é `null`, `NaN` ou infinito — um valor desses na
 * auditoria seria pior do que não a ter.
 */
function numero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const FORMATO_INESPERADO =
  "A operação não devolveu a confirmação esperada. Atualize a página e confirme o estado antes de repetir.";

/**
 * `set_service_payment_atomic` (097) → `TABLE (service_id uuid, cash_amount numeric)`.
 *
 * `cash_amount` é a autoridade sobre quanto entrou em caixa. O `service_id`
 * devolvido é comparado com o pedido: uma resposta sobre outro serviço não é
 * uma confirmação deste.
 */
export function readServicePaymentResult(
  linhas: unknown,
  serviceIdEsperado: string,
): RpcRead<{ serviceId: string; cashAmount: number }> {
  const linha = unicaLinha(linhas);
  if (!linha) return { ok: false, error: FORMATO_INESPERADO };

  const serviceId = uuid(linha.service_id);
  const cashAmount = numero(linha.cash_amount);
  if (serviceId === null || cashAmount === null) return { ok: false, error: FORMATO_INESPERADO };
  if (serviceId.toLowerCase() !== serviceIdEsperado.toLowerCase()) {
    return { ok: false, error: FORMATO_INESPERADO };
  }
  return { ok: true, serviceId, cashAmount };
}

/**
 * `create_cashflow_from_bank_transaction_atomic` (095) →
 * `TABLE (entry_id uuid, match_id uuid)`.
 *
 * A entidade criada é o movimento de caixa, e é o `entry_id` que a auditoria
 * tem de referir — auditar o `bank_transaction_id` no campo da entidade aponta
 * o registo para uma linha que a operação não criou. O `match_id` acompanha
 * como metadado.
 */
export function readBankCashflowResult(
  linhas: unknown,
): RpcRead<{ entryId: string; matchId: string | null }> {
  const linha = unicaLinha(linhas);
  if (!linha) return { ok: false, error: FORMATO_INESPERADO };

  const entryId = uuid(linha.entry_id);
  if (entryId === null) return { ok: false, error: FORMATO_INESPERADO };
  // `match_id` pode legitimamente vir vazio: nem toda a criação vem de uma
  // sugestão. Presente, tem de ser um uuid — texto arbitrário não passa.
  if (linha.match_id != null && uuid(linha.match_id) === null) {
    return { ok: false, error: FORMATO_INESPERADO };
  }
  return { ok: true, entryId, matchId: uuid(linha.match_id) };
}

export const RPC_UNEXPECTED_SHAPE_MESSAGE = FORMATO_INESPERADO;
