import type { FinanceLedgerRow } from "@/domain/finance/ledger";

// 🔴 `fixos` e `variaveis` voltaram a ser filtros de primeira classe.
//
//    A vista anterior tinha duas abas com contagem — «Fixos (12)» /
//    «Variáveis (4)» — e a unificada dissolveu-as num select genérico de
//    "origem", ao lado de Folha, Cobrança e Serviço. O dado nunca se perdeu
//    (vive em `row.origin`), mas a SEPARAÇÃO perdeu-se, e era ela que
//    respondia à pergunta de quem gere: «o que se repete todos os meses, e o
//    que é só deste mês?».
//
//    Um fixo esquecido é uma conta que não se paga; um variável esquecido é
//    um mês mal fechado. São perguntas diferentes e merecem dois separadores,
//    não uma linha num dropdown.
export type FinanceLedgerFilter =
  | "todos"
  | "fixos"
  | "variaveis"
  | "por_pagar"
  | "pagos"
  | "manuais";
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

/** Uma obrigação que se repete de mês para mês. */
export const isFixo = (row: FinanceLedgerRow): boolean =>
  row.row_kind === "payment" && row.origin === "fixo";

/** Uma obrigação pontual deste mês. */
export const isVariavel = (row: FinanceLedgerRow): boolean =>
  row.row_kind === "payment" && row.origin === "variavel";

export function filterFinanceLedger(
  rows: FinanceLedgerRow[],
  filter: FinanceLedgerFilter,
): FinanceLedgerRow[] {
  if (filter === "fixos") return rows.filter(isFixo);
  if (filter === "variaveis") return rows.filter(isVariavel);
  if (filter === "por_pagar") return rows.filter((row) => row.payment_status === "pendente");
  if (filter === "pagos") return rows.filter((row) => row.payment_status === "pago");
  if (filter === "manuais") return rows.filter((row) => row.is_manual);
  return rows;
}

export interface FinanceLedgerCounts {
  todos: number;
  fixos: number;
  variaveis: number;
  por_pagar: number;
  pagos: number;
  manuais: number;
}

/**
 * Contagem por separador, para o número aparecer ao lado do nome como antes.
 *
 * 🔴 Conta sobre TODAS as linhas do período, não sobre as filtradas: um
 *    separador que mostrasse a contagem já filtrada diria sempre o mesmo
 *    número do que está no ecrã, e deixaria de servir para navegar.
 */
export function financeLedgerCounts(rows: FinanceLedgerRow[]): FinanceLedgerCounts {
  return {
    todos: rows.length,
    fixos: rows.filter(isFixo).length,
    variaveis: rows.filter(isVariavel).length,
    por_pagar: rows.filter((row) => row.payment_status === "pendente").length,
    pagos: rows.filter((row) => row.payment_status === "pago").length,
    manuais: rows.filter((row) => row.is_manual).length,
  };
}

/**
 * As categorias oferecidas no filtro: as do catálogo MAIS as que as linhas
 * realmente usam.
 *
 * 🔴 O filtro só olhava para o catálogo activo. Duas situações rompiam-no:
 *
 *      · uma categoria desactivada continua a estar em linhas antigas, e
 *        `getExpenseCategoryCatalog` só devolve as activas;
 *      · quando o catálogo está indisponível devolve `[]` sem falhar — e o
 *        filtro ficava vazio enquanto a tabela mostrava nomes reais.
 *
 *    Nos dois casos alguém via «Manutenção» numa linha e não a encontrava no
 *    filtro. O nome vem do catálogo quando existe; caso contrário, do próprio
 *    ledger, que já o resolveu com a regra de categoria efectiva.
 */
export function categoryFilterOptions(
  rows: FinanceLedgerRow[],
  catalog: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const porId = new Map(catalog.map((item) => [item.id, item.name]));
  for (const row of rows) {
    if (!row.expense_category_id) continue;
    if (porId.has(row.expense_category_id)) continue;
    // Sem nome resolvido, mostra-se o que se sabe em vez de esconder a opção.
    porId.set(row.expense_category_id, row.category_name ?? "Categoria removida");
  }
  return [...porId]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
}

/**
 * O mês ainda não foi lançado — não é o mesmo que «não há nada a pagar».
 *
 * 🔴 A vista anterior distinguia os dois e a unificada perdeu a distinção.
 *    Mostrar totais a 0,00 € num mês por preparar afirma que não há despesa,
 *    quando o que se sabe é apenas que ninguém a registou ainda. Ausência de
 *    dados não é ausência de despesa — e num ecrã financeiro essa diferença
 *    é a diferença entre «está tudo pago» e «ainda não olhámos para isto».
 */
export function mesPorPreparar(rows: FinanceLedgerRow[]): boolean {
  return !rows.some((row) => row.row_kind === "payment");
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
