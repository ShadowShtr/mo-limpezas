// ============================================================================
// T15 — Resumo financeiro por cliente
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não altera dados.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// O gráfico "Receita por Cliente (ano atual)" é construído assim
// (`financial-dashboard.ts`, ~linha 331):
//
//     clientMap.set(inv.client_id, { name, total: existing.total + (inv.total ?? 0) })
//
// `invoices.total` é o valor **com IVA**, e a consulta que o alimenta filtra
// apenas `.neq("status", "cancelado")` — ou seja, **inclui rascunhos**.
//
// Três problemas num só gráfico:
//
//   1. chama-se "Receita" ao **faturado bruto**, imposto incluído. O IVA não é
//      receita da empresa: é dinheiro do Estado que passa pela conta;
//   2. **um rascunho conta como faturação.** Uma fatura ainda por emitir levanta
//      a barra do cliente;
//   3. **um cliente sem fatura é invisível**, mesmo que tenha tido serviços
//      realizados no ano — o que é precisamente o caso das avenças cuja fatura
//      ainda não foi gerada.
//
// A T15 separa os conceitos e deixa a escolha explícita a quem ordena o gráfico.
//
// ----------------------------------------------------------------------------
//
// Sobre nomes de clientes.
//
// O domínio trabalha com `clientId` e valores. **O nome não entra aqui.** Fica
// na fronteira, onde a UI o vai buscar. É a mesma disciplina do `pickContract`
// da T08 e dos `IntegrityIssue.subject` da T14: um DTO financeiro pode acabar
// num ficheiro exportado, e não deve levar dados pessoais consigo.

import { type MoneyCents, ZERO_CENTS, subtractCents, sumCents } from "../billing/money";

/**
 * O que se sabe de um cliente num período. Cada conceito com a sua fonte, como
 * no modelo canónico — nunca um campo `revenue` genérico.
 */
export interface ClientFinancialSummary {
  clientId: string;
  /** Valor dos serviços concluídos deste cliente. */
  performedCents: MoneyCents;
  /** Valor emitido em faturas (exclui rascunho e cancelado). */
  invoicedCents: MoneyCents;
  /** Dinheiro reconhecido em caixa. */
  receivedCents: MoneyCents;
  /** `invoiced − received`. */
  outstandingCents: MoneyCents;
  /** Nº de serviços concluídos. */
  completedServices: number;
  /** `true` se o cliente teve actividade mas nenhuma fatura emitida. */
  performedWithoutInvoice: boolean;
}

export interface ClientContribution {
  clientId: string;
  performedCents?: MoneyCents;
  invoicedCents?: MoneyCents;
  receivedCents?: MoneyCents;
  completedServices?: number;
}

/**
 * Agrega contribuições por cliente.
 *
 * Um cliente aparece se tiver **qualquer** uma das grandezas — não apenas
 * faturação. É esta a correcção do ponto (3) acima: um cliente com serviços
 * realizados e sem fatura passa a ser visível, com `performedWithoutInvoice`
 * a explicar porquê.
 */
export function buildClientSummaries(
  contributions: readonly ClientContribution[],
): ClientFinancialSummary[] {
  const acc = new Map<string, {
    performed: MoneyCents[];
    invoiced: MoneyCents[];
    received: MoneyCents[];
    completed: number;
  }>();

  for (const c of contributions) {
    const entry = acc.get(c.clientId)
      ?? { performed: [], invoiced: [], received: [], completed: 0 };
    if (c.performedCents != null) entry.performed.push(c.performedCents);
    if (c.invoicedCents != null) entry.invoiced.push(c.invoicedCents);
    if (c.receivedCents != null) entry.received.push(c.receivedCents);
    entry.completed += c.completedServices ?? 0;
    acc.set(c.clientId, entry);
  }

  const out: ClientFinancialSummary[] = [];
  for (const [clientId, e] of acc) {
    const performedCents = e.performed.length > 0 ? sumCents(e.performed) : ZERO_CENTS;
    const invoicedCents = e.invoiced.length > 0 ? sumCents(e.invoiced) : ZERO_CENTS;
    const receivedCents = e.received.length > 0 ? sumCents(e.received) : ZERO_CENTS;
    out.push({
      clientId,
      performedCents,
      invoicedCents,
      receivedCents,
      // `subtractCents` da T11, e não uma subtracção com `as MoneyCents`: a
      // regra "em aberto = faturado − recebido" pertence ao modelo canónico, e
      // uma segunda implementação aqui — ainda que aritmeticamente idêntica —
      // seria exactamente a duplicação que estas tasks existem para fechar.
      // O `as` também saltava a verificação de inteiro seguro.
      outstandingCents: subtractCents(invoicedCents, receivedCents),
      completedServices: e.completed,
      performedWithoutInvoice: performedCents > 0 && invoicedCents === 0,
    });
  }

  // Ordem canónica por `clientId` — determinística, independente da ordem de
  // chegada. Quem quiser outra ordem usa `topClientsBy`.
  return out.sort((a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));
}

/**
 * Por que grandeza se ordena o gráfico.
 *
 * Explícito porque "top clientes" não quer dizer nada sozinho: o maior cliente
 * por trabalho realizado pode não ser o maior por dinheiro recebido, e é
 * exactamente essa diferença que interessa a quem cobra.
 */
export type ClientRankingBasis = "performed" | "invoiced" | "received" | "outstanding";

const BASIS_FIELD: Record<ClientRankingBasis, keyof ClientFinancialSummary> = {
  performed: "performedCents",
  invoiced: "invoicedCents",
  received: "receivedCents",
  outstanding: "outstandingCents",
};

export function clientValueBy(
  summary: ClientFinancialSummary,
  basis: ClientRankingBasis,
): MoneyCents {
  return summary[BASIS_FIELD[basis]] as MoneyCents;
}

/**
 * Os N maiores por uma grandeza declarada.
 *
 * Desempate por `clientId` para que dois clientes com o mesmo valor apareçam
 * sempre pela mesma ordem — sem isso, o gráfico trocaria de ordem entre
 * carregamentos sem nada ter mudado nos dados.
 */
export function topClientsBy(
  summaries: readonly ClientFinancialSummary[],
  basis: ClientRankingBasis,
  limit = 8,
): ClientFinancialSummary[] {
  return [...summaries]
    .sort((a, b) => {
      const av = clientValueBy(a, basis);
      const bv = clientValueBy(b, basis);
      if (av !== bv) return bv - av;
      return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

/** Clientes com trabalho feito e nenhuma fatura emitida. Sinal de cobrança. */
export function clientsPerformedWithoutInvoice(
  summaries: readonly ClientFinancialSummary[],
): ClientFinancialSummary[] {
  return summaries.filter((s) => s.performedWithoutInvoice);
}

/** Total de uma grandeza sobre todos os clientes. */
export function totalClientValue(
  summaries: readonly ClientFinancialSummary[],
  basis: ClientRankingBasis,
): MoneyCents {
  const values = summaries.map((s) => clientValueBy(s, basis));
  return values.length > 0 ? sumCents(values) : ZERO_CENTS;
}
