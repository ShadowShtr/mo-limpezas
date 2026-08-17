// ============================================================================
// Criação atómica de faturas (072)
// ============================================================================
//
// A aplicação criava o cabeçalho e as linhas em **dois pedidos**, e compensava
// apagando o cabeçalho quando as linhas falhavam. Funcionava — enquanto a
// compensação corresse. Se o processo morresse entre os dois, ficava um
// documento sem linhas: subtotal e total certos, zero itens, e com o ar de uma
// fatura normal na lista.
//
// E o número era escolhido em JavaScript a partir do máximo lido. Duas
// gerações simultâneas lêem o mesmo máximo e escolhem o mesmo número; nenhuma
// verificação feita aqui ganha essa corrida.
//
// Ambos se resolvem na base, e só na base. Este módulo é a fronteira.
// ============================================================================

import type { ClienteRpc } from "./payment-cashflow";

export const RPC_CRIAR_FATURA = "create_invoice_with_items" as const;

export interface LinhaFaturaRpc {
  /** `null` para linhas de avença: cobrem um contrato, não uma visita. */
  service_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  sort_order: number;
}

export interface EntradaFatura {
  companyId: string;
  clientId: string;
  prefix: string;
  year: number;
  invoiceDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  items: LinhaFaturaRpc[];
}

export type ResultadoFatura =
  | { ok: true; invoiceId: string; invoiceNumber: string }
  | { ok: false; error: string; motivo: MotivoFalhaFatura };

export type MotivoFalhaFatura =
  | "semLinhas"
  | "rpcEmFalta"
  | "rascunhoDuplicado"
  | "numeroRepetido"
  | "recusadoPelaBase"
  | "respostaInesperada";

export function construirArgumentosFatura(e: EntradaFatura): Record<string, unknown> {
  return {
    p_company_id: e.companyId,
    p_client_id: e.clientId,
    p_prefix: e.prefix,
    p_year: e.year,
    p_invoice_date: e.invoiceDate,
    p_due_date: e.dueDate,
    p_period_start: e.periodStart,
    p_period_end: e.periodEnd,
    p_subtotal: e.subtotal,
    p_vat_rate: e.vatRate,
    p_vat_amount: e.vatAmount,
    p_total: e.total,
    // 🔴 `service_id` vai em cada linha. É por essa coluna que
    //    `getUnbilledServices` sabe o que já foi faturado — sem ela, as
    //    faturas nasciam certas e os serviços que elas cobravam continuavam a
    //    aparecer como «por faturar», até alguém os faturar outra vez.
    p_items: e.items,
  };
}

export function interpretarErroFatura(
  erro: { message: string; code?: string },
  numeroConhecido?: string,
): { error: string; motivo: MotivoFalhaFatura } {
  const msg = erro.message ?? "";
  const qual = numeroConhecido ? ` (${numeroConhecido})` : "";

  if (
    erro.code === "PGRST202" || erro.code === "42883" ||
    /could not find the function|does not exist/i.test(msg)
  ) {
    return {
      motivo: "rpcEmFalta",
      error:
        "A criação atómica de faturas não está disponível nesta base: falta aplicar a migration 072. " +
        "Nenhuma fatura foi criada.",
    };
  }

  // 23505 = índice único. Qual deles, diz a mensagem — e a diferença importa
  // para quem lê: um é uma repetição inofensiva, o outro é um conflito real.
  if (erro.code === "23505") {
    if (/uq_invoices_draft_per_client_period/.test(msg)) {
      return {
        motivo: "rascunhoDuplicado",
        error:
          "Já existe um rascunho deste cliente para este período. " +
          "Emita ou apague o existente antes de gerar outra vez.",
      };
    }
    if (/uq_invoices_number_per_company/.test(msg)) {
      return {
        motivo: "numeroRepetido",
        error: `O número de fatura${qual} já existe. Tente novamente.`,
      };
    }
  }

  if (/sem linhas/i.test(msg)) {
    return { motivo: "semLinhas", error: msg };
  }

  return { motivo: "recusadoPelaBase", error: msg || "A base recusou criar a fatura." };
}

export function interpretarRespostaFatura(resposta: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): ResultadoFatura {
  if (resposta.error) return { ok: false, ...interpretarErroFatura(resposta.error) };

  const linha = Array.isArray(resposta.data)
    ? (resposta.data[0] as Record<string, unknown> | undefined)
    : (resposta.data as Record<string, unknown> | null);

  const id = linha?.invoice_id;
  const numero = linha?.invoice_number;

  // A função devolve sempre as duas coisas. Uma resposta sem elas não é
  // sucesso: dar por criada uma fatura que não se sabe qual é impede tanto
  // corrigi-la como apagá-la.
  if (typeof id !== "string" || typeof numero !== "string") {
    return {
      ok: false,
      motivo: "respostaInesperada",
      error: "A base respondeu sem identificar a fatura criada. Verifique antes de gerar outra vez.",
    };
  }

  return { ok: true, invoiceId: id, invoiceNumber: numero };
}

/**
 * Cria a fatura e as linhas numa só transacção.
 *
 * 🔴 Sem linhas, não se chama sequer. A 072 recusa — «uma fatura sem linhas é
 *    um documento a zero que parece emitido» — mas gastar uma ida à base para
 *    ouvir isso é desperdício, e a mensagem sai daqui mais clara.
 */
export async function criarFaturaComLinhas(
  cliente: ClienteRpc,
  entrada: EntradaFatura,
): Promise<ResultadoFatura> {
  if (entrada.items.length === 0) {
    return {
      ok: false,
      motivo: "semLinhas",
      error: "Não há nada para faturar a este cliente neste período.",
    };
  }
  return interpretarRespostaFatura(
    await cliente.rpc(RPC_CRIAR_FATURA, construirArgumentosFatura(entrada)),
  );
}
