"use server";

import { requireProfile } from "@/lib/auth-guard";
import {
  loadFinanceLedger,
  type FinanceLedgerPeriod,
  type FinanceLedgerResult,
  type FinanceLedgerSource,
} from "@/lib/finance-ledger-query";
import type {
  FinanceLedgerCashflowSource,
  FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";

interface CategoryRelation {
  name: string;
}

interface PaymentRecord extends Omit<FinanceLedgerPaymentSource, "category_name"> {
  expense_categories?: CategoryRelation | CategoryRelation[] | null;
}

interface CashflowRecord extends Omit<FinanceLedgerCashflowSource, "category_name"> {
  expense_categories?: CategoryRelation | CategoryRelation[] | null;
}

const PAYMENT_COLUMNS = "id, kind, description, amount, due_date, status, period_year, period_month, paid_at, direct_debit, notes, expense_category_id, created_at, updated_at, expense_categories(name)";
const CASHFLOW_COLUMNS = "id, type, amount, description, category, date, reference_type, reference_id, status, notes, expense_category_id, created_at, expense_categories(name)";

function categoryName(relation: CategoryRelation | CategoryRelation[] | null | undefined): string | null {
  const category = Array.isArray(relation) ? relation[0] : relation;
  return category?.name ?? null;
}

function payments(rows: unknown[] | null): FinanceLedgerPaymentSource[] {
  return (rows ?? []).map((value) => {
    const row = value as PaymentRecord;
    return { ...row, category_name: categoryName(row.expense_categories) };
  });
}

function cashflows(rows: unknown[] | null): FinanceLedgerCashflowSource[] {
  return (rows ?? []).map((value) => {
    const row = value as CashflowRecord;
    return { ...row, category_name: categoryName(row.expense_categories) };
  });
}

function monthRange(period: FinanceLedgerPeriod): { start: string; end: string } {
  const month = String(period.month).padStart(2, "0");
  const lastDay = new Date(period.year, period.month, 0).getDate();
  return {
    start: `${period.year}-${month}-01`,
    end: `${period.year}-${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export async function getFinanceLedger(
  year: number,
  month: number,
): Promise<FinanceLedgerResult> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: "Período financeiro inválido." };
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  const source: FinanceLedgerSource = {
    async paymentsByCompetence(period) {
      const { data, error } = await admin
        .from("fixed_variable_payments")
        .select(PAYMENT_COLUMNS)
        .eq("company_id", companyId)
        .eq("period_year", period.year)
        .eq("period_month", period.month);
      return error ? { ok: false, error: error.message } : { ok: true, data: payments(data) };
    },
    async cashflowsByCashPeriod(period) {
      const range = monthRange(period);
      const { data, error } = await admin
        .from("cash_flow_entries")
        .select(CASHFLOW_COLUMNS)
        .eq("company_id", companyId)
        .gte("date", range.start)
        .lte("date", range.end);
      return error ? { ok: false, error: error.message } : { ok: true, data: cashflows(data) };
    },
    async paymentsByIds(ids) {
      const { data, error } = await admin
        .from("fixed_variable_payments")
        .select(PAYMENT_COLUMNS)
        .eq("company_id", companyId)
        .in("id", ids);
      return error ? { ok: false, error: error.message } : { ok: true, data: payments(data) };
    },
    async cashflowsByPaymentIds(ids) {
      const { data, error } = await admin
        .from("cash_flow_entries")
        .select(CASHFLOW_COLUMNS)
        .eq("company_id", companyId)
        .eq("reference_type", "fixed_variable_payment")
        .in("reference_id", ids);
      return error ? { ok: false, error: error.message } : { ok: true, data: cashflows(data) };
    },
  };

  return loadFinanceLedger(source, { year, month });
}
