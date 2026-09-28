import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
  type FinanceLedgerRow,
} from "@/domain/finance/ledger";
import { ORIGEM_PAGAMENTO } from "@/domain/finance-v2/effective-expense-category";

export interface FinanceLedgerPeriod {
  year: number;
  month: number;
}

type SourceResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface FinanceLedgerSource {
  paymentsByCompetence(period: FinanceLedgerPeriod): Promise<SourceResult<FinanceLedgerPaymentSource[]>>;
  cashflowsByCashPeriod(period: FinanceLedgerPeriod): Promise<SourceResult<FinanceLedgerCashflowSource[]>>;
  paymentsByIds(ids: string[]): Promise<SourceResult<FinanceLedgerPaymentSource[]>>;
  cashflowsByPaymentIds(ids: string[]): Promise<SourceResult<FinanceLedgerCashflowSource[]>>;
  /**
   * Pagamentos AINDA pendentes de competências anteriores ao período.
   *
   * 🔴 Existe como fonte própria, com nome próprio, de propósito.
   *
   *    A alternativa era alargar `paymentsByCompetence` para trazer «o mês e
   *    também o que ficou para trás». Isso deixaria a função a mentir no nome
   *    e passaria a decidir política dentro de uma consulta que só devia
   *    responder por um mês — e todos os separadores herdariam a carga extra
   *    sem ninguém ter decidido isso.
   *
   *    Aqui a excepção está declarada: só «Por pagar» a usa, o filtro é que a
   *    aplica (`pendenteTransitado`), e quem lê a interface vê exactamente o
   *    que entra no razão e porquê.
   *
   *    Não é «todo o histórico»: é o conjunto do que continua por pagar, que
   *    numa empresa a funcionar é pequeno e, por definição, é o que ainda
   *    interessa. O que já foi pago não volta.
   */
  pendingPaymentsBeforeCompetence(period: FinanceLedgerPeriod): Promise<SourceResult<FinanceLedgerPaymentSource[]>>;
}

export type FinanceLedgerResult =
  | { ok: true; rows: FinanceLedgerRow[] }
  | { ok: false; error: string };

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** Loads both time axes and then resolves persisted payment links. */
export async function loadFinanceLedger(
  source: FinanceLedgerSource,
  period: FinanceLedgerPeriod,
): Promise<FinanceLedgerResult> {
  const [paymentsResult, cashflowsResult, overdueResult] = await Promise.all([
    source.paymentsByCompetence(period),
    source.cashflowsByCashPeriod(period),
    source.pendingPaymentsBeforeCompetence(period),
  ]);
  if (!paymentsResult.ok) return paymentsResult;
  if (!cashflowsResult.ok) return cashflowsResult;
  if (!overdueResult.ok) return overdueResult;

  // 🔴 A deduplicação é por `id` e acontece ANTES de construir o razão.
  //
  //    Um pendente transitado pode chegar por duas portas ao mesmo tempo — a
  //    fonte de atrasados e a resolução de referências de caixa — e duas
  //    linhas com o mesmo `payment_id` contariam o dinheiro duas vezes nos
  //    totais e no número do separador.
  const payments = uniqueById([...paymentsResult.data, ...overdueResult.data]);
  const cashflows = cashflowsResult.data;
  const paymentIds = payments.map((row) => row.id);
  const referencedPaymentIds = [...new Set(cashflows
    .filter((row) => row.reference_type === ORIGEM_PAGAMENTO && row.reference_id)
    .map((row) => row.reference_id as string)
    .filter((id) => !paymentIds.includes(id)))];

  const [linkedCashflowsResult, referencedPaymentsResult] = await Promise.all([
    paymentIds.length > 0
      ? source.cashflowsByPaymentIds(paymentIds)
      : Promise.resolve({ ok: true as const, data: [] }),
    referencedPaymentIds.length > 0
      ? source.paymentsByIds(referencedPaymentIds)
      : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  if (!linkedCashflowsResult.ok) return linkedCashflowsResult;
  if (!referencedPaymentsResult.ok) return referencedPaymentsResult;

  return {
    ok: true,
    rows: buildFinanceLedger({
      payments: uniqueById([...payments, ...referencedPaymentsResult.data]),
      cashflows: uniqueById([...cashflows, ...linkedCashflowsResult.data]),
    }),
  };
}
