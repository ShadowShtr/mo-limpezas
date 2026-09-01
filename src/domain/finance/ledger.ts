import { paraCentimos } from "@/domain/finance-v2/money";
import { ORIGEM_PAGAMENTO } from "@/domain/finance-v2/effective-expense-category";

export type FinanceLedgerDirection = "entrada" | "saida";
export type FinanceLedgerRowKind = "payment" | "cashflow";
export type FinanceLedgerStatus =
  | "pendente"
  | "pago"
  | "pendente_confirmacao"
  | "confirmado";

export interface FinanceLedgerCategory {
  id: string | null;
  name: string | null;
}

export interface FinanceLedgerPaymentSource {
  id: string;
  kind: "fixo" | "variavel";
  description: string;
  amount: number | null;
  due_date: string | null;
  status: "pago" | "pendente";
  period_year: number;
  period_month: number;
  paid_at: string | null;
  /**
   * Débito directo e notas — a vista unificada mostra-os e o formulário
   * edita-os. Opcionais na FONTE: quem não os selecionar continua a produzir
   * um ledger válido, e a linha fica com `null` em vez de `undefined`.
   */
  direct_debit?: boolean | null;
  notes?: string | null;
  sort_order?: number | null;
  expense_category_id: string | null;
  category_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinanceLedgerCashflowSource {
  id: string;
  type: FinanceLedgerDirection;
  amount: number;
  description: string;
  category: string | null;
  date: string;
  reference_type: string | null;
  reference_id: string | null;
  status: "pendente" | "confirmado";
  notes?: string | null;
  expense_category_id: string | null;
  category_name: string | null;
  created_at: string;
}

export interface FinanceLedgerRow {
  row_id: string;
  row_kind: FinanceLedgerRowKind;
  payment_id: string | null;
  cashflow_id: string | null;
  direction: FinanceLedgerDirection;
  date: string;
  due_date: string | null;
  description: string;
  expense_category_id: string | null;
  category_name: string | null;
  origin: string;
  amount_cents: number | null;
  /**
   * Os dois lados do mesmo movimento, separados de propósito.
   *
   * 🔴 `amount_cents` responde «quanto é esta linha». Estes dois respondem
   *    «quanto é a obrigação» e «quanto saiu de caixa» — e é precisamente
   *    quando divergem que existe `linked_amount_mismatch`. Colapsá-los num
   *    só número apagaria a divergência do resumo, que é onde ela tem de
   *    aparecer: o total por competência usa o valor do pagamento, o total de
   *    caixa usa o do movimento.
   */
  payment_amount_cents: number | null;
  cashflow_amount_cents: number | null;
  /** Só existem na linha de pagamento; num movimento manual são `null`. */
  direct_debit: boolean | null;
  notes: string | null;
  sort_order: number | null;
  status: FinanceLedgerStatus;
  payment_status: "pago" | "pendente" | null;
  cashflow_status: "pendente" | "confirmado" | null;
  is_manual: boolean;
  is_linked: boolean;
  created_at: string;
  revision: string;
  competence_year: number | null;
  competence_month: number | null;
  cash_date: string | null;
  integrity_issue:
    | "linked_amount_mismatch"
    | "orphan_payment_reference"
    | "duplicate_payment_link"
    | null;
}

export interface BuildFinanceLedgerInput {
  payments: FinanceLedgerPaymentSource[];
  cashflows: FinanceLedgerCashflowSource[];
}

const text = (value: string | null | undefined): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const civilDate = (value: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" })
    .format(new Date(value));
};

function paymentDate(
  payment: FinanceLedgerPaymentSource,
  linked: FinanceLedgerCashflowSource | null,
): string {
  if (linked) return linked.date;
  if (payment.status === "pago" && payment.paid_at) return civilDate(payment.paid_at);
  return civilDate(payment.created_at);
}

function paymentRevision(
  payment: FinanceLedgerPaymentSource,
  linked: FinanceLedgerCashflowSource | null,
): string {
  const candidates = [payment.updated_at, payment.created_at, linked?.created_at ?? ""];
  return candidates.sort().at(-1) ?? payment.updated_at;
}

function paymentRow(
  payment: FinanceLedgerPaymentSource,
  linked: FinanceLedgerCashflowSource | null,
  duplicado = false,
): FinanceLedgerRow {
  const paymentCents = payment.amount === null ? null : paraCentimos(payment.amount);
  const cashCents = linked ? paraCentimos(linked.amount) : null;
  return {
    row_id: `payment:${payment.id}`,
    row_kind: "payment",
    payment_id: payment.id,
    cashflow_id: linked?.id ?? null,
    direction: "saida",
    date: paymentDate(payment, linked),
    due_date: payment.due_date,
    description: payment.description,
    expense_category_id: payment.expense_category_id,
    category_name: text(payment.category_name),
    origin: payment.kind,
    amount_cents: paymentCents,
    payment_amount_cents: paymentCents,
    cashflow_amount_cents: cashCents,
    direct_debit: payment.direct_debit ?? null,
    notes: text(payment.notes),
    sort_order: payment.sort_order ?? null,
    status: payment.status,
    payment_status: payment.status,
    cashflow_status: linked?.status ?? null,
    is_manual: false,
    is_linked: linked !== null,
    created_at: payment.created_at,
    revision: paymentRevision(payment, linked),
    competence_year: payment.period_year,
    competence_month: payment.period_month,
    cash_date: linked?.date ?? null,
    // 🔴 O duplicado vem primeiro: se houver dois movimentos ligados ao mesmo
    //    pagamento, isso é mais grave do que uma divergência de valor — quer
    //    dizer que a identidade económica se partiu, e é ela que sustenta tudo
    //    o resto neste modelo.
    integrity_issue: duplicado
      ? "duplicate_payment_link"
      : linked && paymentCents !== null && cashCents !== paymentCents
        ? "linked_amount_mismatch"
        : null,
  };
}

function cashflowRow(
  cashflow: FinanceLedgerCashflowSource,
  problema: FinanceLedgerRow["integrity_issue"] = null,
): FinanceLedgerRow {
  const manual = cashflow.reference_type === null && cashflow.reference_id === null;
  return {
    row_id: `cashflow:${cashflow.id}`,
    row_kind: "cashflow",
    payment_id: null,
    cashflow_id: cashflow.id,
    direction: cashflow.type,
    date: cashflow.date,
    due_date: null,
    description: cashflow.description,
    expense_category_id: cashflow.expense_category_id,
    category_name: text(cashflow.category_name) ?? text(cashflow.category),
    origin: manual ? "manual" : (text(cashflow.reference_type) ?? "manual"),
    amount_cents: paraCentimos(cashflow.amount),
    // Uma linha de caixa não tem obrigação por trás: o lado da competência
    // fica `null` em vez de repetir o valor e fingir que existem dois lados.
    payment_amount_cents: null,
    cashflow_amount_cents: paraCentimos(cashflow.amount),
    direct_debit: null,
    notes: text(cashflow.notes),
    sort_order: null,
    status: cashflow.status === "confirmado" ? "confirmado" : "pendente_confirmacao",
    payment_status: null,
    cashflow_status: cashflow.status,
    is_manual: manual,
    is_linked: false,
    created_at: cashflow.created_at,
    revision: cashflow.created_at,
    competence_year: null,
    competence_month: null,
    cash_date: cashflow.date,
    integrity_issue: problema,
  };
}

/**
 * Une obrigações e caixa sem inferir relações por texto, valor ou data.
 * A única deduplicação permitida é a identidade de origem persistida.
 */
export function buildFinanceLedger(input: BuildFinanceLedgerInput): FinanceLedgerRow[] {
  const payments = new Map(input.payments.map((payment) => [payment.id, payment]));

  // Agrupa por pagamento em vez de guardar só um. A diferença importa: antes,
  // o segundo movimento ligado ao mesmo pagamento era escolhido contra o
  // primeiro e depois **desaparecia do razão** — dinheiro fora do ecrã, sem
  // aviso. Uma leitura financeira pode recusar-se a explicar uma linha; não
  // pode fazê-la sumir.
  const ligados = new Map<string, FinanceLedgerCashflowSource[]>();
  for (const cashflow of input.cashflows) {
    if (cashflow.reference_type !== ORIGEM_PAGAMENTO || !cashflow.reference_id) continue;
    const lista = ligados.get(cashflow.reference_id);
    if (lista) lista.push(cashflow);
    else ligados.set(cashflow.reference_id, [cashflow]);
  }

  // Ordem determinística dentro de cada grupo: o mais antigo é o representante.
  // `created_at` pode empatar — o `id` desempata, para a mesma entrada dar
  // sempre a mesma saída.
  for (const lista of ligados.values()) {
    lista.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  const rows: FinanceLedgerRow[] = [];
  for (const payment of payments.values()) {
    const grupo = ligados.get(payment.id) ?? [];
    rows.push(paymentRow(payment, grupo[0] ?? null, grupo.length > 1));
  }

  for (const cashflow of input.cashflows) {
    const paymentId = cashflow.reference_type === ORIGEM_PAGAMENTO
      ? cashflow.reference_id
      : null;

    if (paymentId && payments.has(paymentId)) {
      const grupo = ligados.get(paymentId) ?? [];
      // O representante já vive dentro da linha do pagamento — é isso que faz
      // do par UM facto económico. Os restantes saem como linhas próprias,
      // marcados, porque o estado que os produziu é impossível: o índice único
      // `cash_flow_entries_reference_unique` impede-o dentro de uma empresa.
      // Se algum dia chegarem aqui, é corrupção, e corrupção mostra-se.
      if (grupo.length > 1 && cashflow.id !== grupo[0].id) {
        rows.push(cashflowRow(cashflow, "duplicate_payment_link"));
      }
      continue;
    }

    rows.push(cashflowRow(cashflow, paymentId ? "orphan_payment_reference" : null));
  }

  return rows.sort((a, b) =>
    b.date.localeCompare(a.date)
    || b.created_at.localeCompare(a.created_at)
    || a.row_id.localeCompare(b.row_id),
  );
}
