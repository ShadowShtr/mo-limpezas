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
  const [paymentsResult, cashflowsResult] = await Promise.all([
    source.paymentsByCompetence(period),
    source.cashflowsByCashPeriod(period),
  ]);
  if (!paymentsResult.ok) return paymentsResult;
  if (!cashflowsResult.ok) return cashflowsResult;

  const payments = paymentsResult.data;
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
