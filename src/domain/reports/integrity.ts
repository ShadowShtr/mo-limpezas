// ============================================================================
// T14 — Integridade e completude dos relatórios
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não corrige nada. **Só detecta e
// classifica.** Nenhuma função aqui altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha: erro de consulta a fingir-se de zero.
//
// O padrão está em todo o lado nos relatórios actuais:
//
//     const { data: locations } = await admin.from("locations")...   // sem error
//     const { data: contracts } = await admin.from("contracts")...   // sem error
//     const { data: clients }   = await admin.from("clients")...     // sem error
//
// Quando a consulta falha, `data` vem `null`, o `?? []` a seguir transforma-a
// em lista vazia, e o relatório apresenta **0 € de receita** com o mesmo aspecto
// de um mês em que realmente não houve receita. Não há aviso, não há log, não há
// forma de distinguir os dois casos a olhar para o ecrã.
//
// Num relatório financeiro isso é pior do que um erro: é um número errado com
// ar de número certo, sobre o qual alguém decide.
//
// A regra da T14: **falha de fonte nunca vira zero.** Vira `FAILED`/`PARTIAL`,
// com um código estável, e o valor correspondente fica `UNAVAILABLE` (o
// `null ≠ zero` que a T11 já fixou em `FinancialAmount`).
//
// ----------------------------------------------------------------------------
//
// O que NÃO sai daqui.
//
// Nenhum código de erro carrega a mensagem do Supabase, o SQL, o nome da
// política de RLS ou a stack. Esses detalhes são para os logs do servidor. O
// relatório leva um código estável (`INVOICES_QUERY_FAILED`) e, quando muito,
// uma nota técnica curta escrita por nós — nunca texto vindo do driver.

// ─── Fontes ─────────────────────────────────────────────────────────────────

/**
 * As tabelas de que um relatório depende. Nomeadas pela tabela real do schema,
 * para que um código de erro seja rastreável sem adivinhação.
 */
export type ReportSource =
  | "services"
  | "contracts"
  | "invoices"
  | "invoice_items"
  | "cash_flow_entries"
  | "payroll_records"
  | "timesheets"
  | "absences"
  | "company_settings";

export const REPORT_SOURCES: readonly ReportSource[] = [
  "services",
  "contracts",
  "invoices",
  "invoice_items",
  "cash_flow_entries",
  "payroll_records",
  "timesheets",
  "absences",
  "company_settings",
];

/**
 * Estado de carregamento de uma fonte.
 *
 * `NOT_REQUESTED` é distinto de `FAILED` de propósito: um relatório operacional
 * que nunca pediu a folha de pagamento não está degradado — está a responder a
 * outra pergunta. Confundir os dois faria todos os relatórios parecerem
 * parciais para sempre, e um aviso que aparece sempre deixa de ser lido.
 */
export type SourceStatus = "LOADED" | "FAILED" | "NOT_REQUESTED";

export interface SourceOutcome {
  source: ReportSource;
  status: SourceStatus;
  /** Nota técnica curta, escrita por nós. Nunca a mensagem do driver. */
  note?: string;
}

export function loaded(source: ReportSource): SourceOutcome {
  return { source, status: "LOADED" };
}

export function failed(source: ReportSource, note?: string): SourceOutcome {
  return { source, status: "FAILED", note };
}

export function notRequested(source: ReportSource): SourceOutcome {
  return { source, status: "NOT_REQUESTED" };
}

/**
 * Resultado de uma consulta já feita, na forma que o domínio aceita.
 *
 * Existe para forçar quem carrega os dados a decidir explicitamente o que fazer
 * com o `error` do Supabase. Não há construtor que aceite `data` sem uma
 * decisão sobre o erro — é essa a diferença face ao `const { data } = ...` que
 * o código actual usa.
 */
export type SourceResult<T> =
  | { ok: true; rows: readonly T[] }
  | { ok: false; note?: string };

export function sourceOk<T>(rows: readonly T[]): SourceResult<T> {
  return { ok: true, rows };
}

export function sourceFailed<T>(note?: string): SourceResult<T> {
  return { ok: false, note };
}

/** Linhas de uma fonte que falhou, para agregação. Nunca confundir com "zero". */
export function rowsOf<T>(result: SourceResult<T>): readonly T[] {
  return result.ok ? result.rows : [];
}

// ─── Códigos de integridade ─────────────────────────────────────────────────

/**
 * Códigos estáveis. Estáveis porque a UI, os testes e o comparador se referem a
 * eles pelo nome — renomear um é uma alteração de contrato, não um detalhe.
 *
 * Dividem-se em duas famílias:
 *
 *   `*_QUERY_FAILED`  — a fonte não carregou. O relatório está degradado.
 *   os restantes      — a fonte carregou e os dados são internamente
 *                       inconsistentes. O relatório está completo mas há algo
 *                       para investigar na base.
 *
 * Nenhum destes códigos autoriza uma correcção automática. A T14 detecta; a
 * decisão de reparar depende do diagnóstico read-only que ainda não existe
 * (ver §5 de `docs/HANDOFF-2026-08-07.md`).
 */
export type IntegrityCode =
  // Falhas de fonte
  | "SERVICES_QUERY_FAILED"
  | "CONTRACTS_QUERY_FAILED"
  | "INVOICES_QUERY_FAILED"
  | "INVOICE_ITEMS_QUERY_FAILED"
  | "PAYMENTS_QUERY_FAILED"
  | "PAYROLL_QUERY_FAILED"
  | "TIMESHEETS_QUERY_FAILED"
  | "ABSENCES_QUERY_FAILED"
  | "SETTINGS_QUERY_FAILED"
  // Inconsistências nos dados carregados
  | "INVOICED_WITHOUT_ITEMS"
  | "RECEIVED_GT_INVOICED"
  | "NEGATIVE_OUTSTANDING"
  | "MONTHLY_ALLOCATION_MISMATCH"
  | "UNALLOCATED_MONTHLY_AMOUNT"
  | "MISSING_FINANCIAL_SOURCE"
  | "DUPLICATE_SERVICE_ID"
  | "DUPLICATE_INVOICE_ITEM"
  | "UNKNOWN_STATUS"
  | "INVALID_DATE_RANGE"
  | "RECORD_OUTSIDE_PERIOD"
  | "PARTIAL_MONTH_WINDOW"
  | "VAT_RATE_UNAVAILABLE";

/** Gravidade. Só ordena a apresentação — não muda o cálculo. */
export type IntegritySeverity = "ERROR" | "WARNING" | "INFO";

export interface IntegrityIssue {
  code: IntegrityCode;
  severity: IntegritySeverity;
  /** Fonte em causa, quando aplicável. */
  source?: ReportSource;
  /**
   * Identificador técnico do registo (`services.id`, `contracts.id`, uma data).
   * Nunca nome de cliente, morada ou qualquer dado pessoal — um relatório de
   * integridade pode acabar num ficheiro exportado.
   */
  subject?: string;
  /** Explicação técnica curta, escrita por nós. */
  detail?: string;
}

const SEVERITY_OF: Record<IntegrityCode, IntegritySeverity> = {
  SERVICES_QUERY_FAILED: "ERROR",
  CONTRACTS_QUERY_FAILED: "ERROR",
  INVOICES_QUERY_FAILED: "ERROR",
  INVOICE_ITEMS_QUERY_FAILED: "ERROR",
  PAYMENTS_QUERY_FAILED: "ERROR",
  PAYROLL_QUERY_FAILED: "ERROR",
  TIMESHEETS_QUERY_FAILED: "ERROR",
  ABSENCES_QUERY_FAILED: "ERROR",
  SETTINGS_QUERY_FAILED: "ERROR",
  INVOICED_WITHOUT_ITEMS: "WARNING",
  RECEIVED_GT_INVOICED: "WARNING",
  NEGATIVE_OUTSTANDING: "WARNING",
  MONTHLY_ALLOCATION_MISMATCH: "ERROR",
  UNALLOCATED_MONTHLY_AMOUNT: "WARNING",
  MISSING_FINANCIAL_SOURCE: "WARNING",
  DUPLICATE_SERVICE_ID: "ERROR",
  DUPLICATE_INVOICE_ITEM: "WARNING",
  UNKNOWN_STATUS: "WARNING",
  INVALID_DATE_RANGE: "ERROR",
  RECORD_OUTSIDE_PERIOD: "INFO",
  PARTIAL_MONTH_WINDOW: "INFO",
  VAT_RATE_UNAVAILABLE: "WARNING",
};

export function issue(
  code: IntegrityCode,
  extra: Omit<IntegrityIssue, "code" | "severity"> = {},
): IntegrityIssue {
  return { code, severity: SEVERITY_OF[code], ...extra };
}

/** O código de falha de cada fonte. Tabela explícita, sem construir strings. */
const FAILURE_CODE_OF: Record<ReportSource, IntegrityCode> = {
  services: "SERVICES_QUERY_FAILED",
  contracts: "CONTRACTS_QUERY_FAILED",
  invoices: "INVOICES_QUERY_FAILED",
  invoice_items: "INVOICE_ITEMS_QUERY_FAILED",
  cash_flow_entries: "PAYMENTS_QUERY_FAILED",
  payroll_records: "PAYROLL_QUERY_FAILED",
  timesheets: "TIMESHEETS_QUERY_FAILED",
  absences: "ABSENCES_QUERY_FAILED",
  company_settings: "SETTINGS_QUERY_FAILED",
};

export function failureCodeOf(source: ReportSource): IntegrityCode {
  return FAILURE_CODE_OF[source];
}

/** Converte os estados das fontes nos respectivos problemas. */
export function issuesFromOutcomes(outcomes: readonly SourceOutcome[]): IntegrityIssue[] {
  return outcomes
    .filter((o) => o.status === "FAILED")
    .map((o) => issue(failureCodeOf(o.source), { source: o.source, detail: o.note }));
}

// ─── Completude do relatório ────────────────────────────────────────────────

/**
 * Estado global do relatório.
 *
 *   COMPLETE — todas as fontes pedidas carregaram.
 *   PARTIAL  — alguma falhou, mas há pelo menos uma com dados.
 *   FAILED   — nenhuma das fontes pedidas carregou. Não há relatório nenhum.
 *
 * A distinção PARTIAL/FAILED interessa à UI: um relatório PARTIAL mostra-se com
 * aviso; um FAILED não se mostra de todo, porque exibir zeros seria mentir.
 */
export type ReportCompleteness = "COMPLETE" | "PARTIAL" | "FAILED";

export function computeCompleteness(outcomes: readonly SourceOutcome[]): ReportCompleteness {
  const requested = outcomes.filter((o) => o.status !== "NOT_REQUESTED");
  if (requested.length === 0) return "FAILED";
  const ok = requested.filter((o) => o.status === "LOADED").length;
  if (ok === requested.length) return "COMPLETE";
  if (ok === 0) return "FAILED";
  return "PARTIAL";
}

/**
 * Traduz a completude do relatório para a `Completeness` de um montante da T11.
 *
 * Uma fonte que falhou torna o montante `UNAVAILABLE` (`cents: null`), nunca
 * zero. Um relatório globalmente `PARTIAL` não degrada um montante cuja própria
 * fonte carregou — o faturado continua `COMPLETE` mesmo que a folha tenha
 * falhado; o que fica degradado é a margem, e isso a T11 já deriva sozinha em
 * `weakestCompleteness`.
 */
export function completenessOfSource(
  source: ReportSource,
  outcomes: readonly SourceOutcome[],
): "COMPLETE" | "PARTIAL" | "UNAVAILABLE" {
  const found = outcomes.find((o) => o.source === source);
  if (!found) return "UNAVAILABLE";
  if (found.status === "LOADED") return "COMPLETE";
  return "UNAVAILABLE";
}

/** Ordena por gravidade e depois por código, para uma apresentação estável. */
export function sortIssues(issues: readonly IntegrityIssue[]): IntegrityIssue[] {
  const rank: Record<IntegritySeverity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  return [...issues].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return (a.subject ?? "").localeCompare(b.subject ?? "");
  });
}

/** Conta os problemas por código. Usado nos testes e no comparador. */
export function countByCode(
  issues: readonly IntegrityIssue[],
): Partial<Record<IntegrityCode, number>> {
  const out: Partial<Record<IntegrityCode, number>> = {};
  for (const i of issues) out[i.code] = (out[i.code] ?? 0) + 1;
  return out;
}
