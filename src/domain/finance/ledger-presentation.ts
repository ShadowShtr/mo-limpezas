import type { FinanceLedgerRow } from "@/domain/finance/ledger";

export type FinanceLedgerFilter = "todos" | "por_pagar" | "pagos" | "manuais";
export type FinanceGraphMode = "competencia" | "caixa";

export interface FinanceLedgerMetrics {
  due_cents: number;
  paid_cents: number;
  overdue_cents: number;
  cash_output_cents: number;
}

export interface FinanceCategorySlice {
  category_id: string | null;
  name: string;
  amount_cents: number;
}

export function originLabelFor(origin: string): string {
  const labels: Record<string, string> = {
    fixo: "Fixo",
    variavel: "Variável",
    manual: "Manual",
    payroll: "Folha",
    invoice: "Cobrança",
    service_payment: "Serviço",
    fixed_variable_payment: "Pagamento",
  };
  return labels[origin] ?? "Outra origem";
}

export function originLabel(row: FinanceLedgerRow): string {
  return originLabelFor(row.origin);
}

// ── Integridade ─────────────────────────────────────────────────────────────
//
// 🔴 O read model já detectava as três anomalias; ninguém as mostrava. Uma
//    linha com `integrity_issue` aparecia como "Pago" ou "Confirmado", e
//    continuava a oferecer Editar / Marcar / Eliminar. Ou seja: o sistema
//    sabia que os dois lados não batiam certo e deixava alguém escrever por
//    cima na mesma — que é como uma divergência de € se torna permanente.
//
//    O texto é para quem gere a empresa, não para quem escreveu o SQL: nada
//    de nomes de tabela, RPC ou coluna.

/** Explicação humana da anomalia. `null` quando a linha está sã. */
export function integrityWarning(row: FinanceLedgerRow): string | null {
  switch (row.integrity_issue) {
    case "linked_amount_mismatch":
      return "Valor do pagamento diferente do movimento de caixa";
    case "orphan_payment_reference":
      return "Movimento ligado a um pagamento que já não existe";
    case "duplicate_payment_link":
      return "Mais de um movimento ligado ao mesmo pagamento";
    default:
      return null;
  }
}

/**
 * Uma linha degradada não aceita mutação financeira por esta vista.
 *
 * 🔴 UNKNOWN_STATE = FAIL_CLOSED. Não se repara automaticamente e não se
 *    escolhe um lado como verdade: quando o pagamento diz um valor e o caixa
 *    diz outro, escrever por cima de qualquer um deles apaga a prova de que
 *    divergiram. Quem decide qual está certo é uma pessoa, na origem.
 */
export function canMutateRow(row: FinanceLedgerRow): boolean {
  return row.integrity_issue === null;
}

/** Motivo mostrado quando alguém tenta alterar uma linha degradada. */
export const INTEGRITY_BLOCK_REASON =
  "Este registo tem uma inconsistência entre Pagamentos e Caixa. "
  + "Resolva a origem antes de o alterar.";

export function presentationStatus(row: FinanceLedgerRow, today: string): string {
  // A anomalia vem primeiro: dizer "Pago" sobre uma linha que não fecha seria
  // afirmar precisamente aquilo que não se sabe.
  if (row.integrity_issue !== null) return "Verificar";
  if (row.payment_status === "pendente" && row.due_date && row.due_date < today) {
    return "Em atraso";
  }
  if (row.payment_status === "pendente") return "Pendente";
  if (row.payment_status === "pago") return "Pago";
  if (row.cashflow_status === "pendente") return "Pendente — confirmar";
  return "Confirmado";
}

export function filterFinanceLedger(
  rows: FinanceLedgerRow[],
  filter: FinanceLedgerFilter,
): FinanceLedgerRow[] {
  if (filter === "por_pagar") return rows.filter((row) => row.payment_status === "pendente");
  if (filter === "pagos") return rows.filter((row) => row.payment_status === "pago");
  if (filter === "manuais") return rows.filter((row) => row.is_manual);
  return rows;
}

const inCompetence = (row: FinanceLedgerRow, year: number, month: number): boolean =>
  row.row_kind === "payment"
  && row.competence_year === year
  && row.competence_month === month;

const inCashPeriod = (row: FinanceLedgerRow, year: number, month: number): boolean =>
  Boolean(row.cashflow_id && row.cash_date?.startsWith(`${year}-${String(month).padStart(2, "0")}-`));

export function financeLedgerMetrics(
  rows: FinanceLedgerRow[],
  period: { year: number; month: number },
  today: string,
): FinanceLedgerMetrics {
  let due = 0;
  let paid = 0;
  let overdue = 0;
  let cashOutput = 0;
  for (const row of rows) {
    if (inCompetence(row, period.year, period.month)) {
      const amount = row.payment_amount_cents ?? 0;
      if (row.payment_status === "pendente") {
        due += amount;
        if (row.due_date && row.due_date < today) overdue += amount;
      } else if (row.payment_status === "pago") {
        paid += amount;
      }
    }
    if (inCashPeriod(row, period.year, period.month) && row.direction === "saida" && row.cashflow_status === "confirmado") {
      cashOutput += row.cashflow_amount_cents ?? 0;
    }
  }
  return { due_cents: due, paid_cents: paid, overdue_cents: overdue, cash_output_cents: cashOutput };
}

export function categorySlices(
  rows: FinanceLedgerRow[],
  period: { year: number; month: number },
  mode: FinanceGraphMode,
): FinanceCategorySlice[] {
  const totals = new Map<string, FinanceCategorySlice>();
  for (const row of rows) {
    const eligible = mode === "competencia"
      ? inCompetence(row, period.year, period.month)
      : inCashPeriod(row, period.year, period.month)
        && row.direction === "saida"
        && row.cashflow_status === "confirmado";
    if (!eligible) continue;
    const amount = mode === "competencia"
      ? row.payment_amount_cents
      : row.cashflow_amount_cents;
    if (amount === null || amount <= 0) continue;
    const key = row.expense_category_id ?? "uncategorized";
    const current = totals.get(key) ?? {
      category_id: row.expense_category_id,
      name: row.category_name ?? "Sem categoria",
      amount_cents: 0,
    };
    current.amount_cents += amount;
    totals.set(key, current);
  }
  return [...totals.values()].sort((a, b) =>
    b.amount_cents - a.amount_cents || a.name.localeCompare(b.name),
  );
}

export function paginateFinanceLedger(
  rows: FinanceLedgerRow[],
  page: number,
  pageSize: number,
): FinanceLedgerRow[] {
  const safePage = Math.max(1, Math.trunc(page));
  const safeSize = Math.max(1, Math.trunc(pageSize));
  const start = (safePage - 1) * safeSize;
  return rows.slice(start, start + safeSize);
}
