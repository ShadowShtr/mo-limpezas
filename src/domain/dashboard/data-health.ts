// ============================================================================
// T15 — Saúde dos dados financeiros
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não corrige nada.
//
// ----------------------------------------------------------------------------
//
// Para que serve.
//
// O dashboard actual tem um único estado de erro: uma faixa vermelha com a
// mensagem da action quando `getFinancialDashboard` falha por inteiro. Não há
// nada entre "tudo bem" e "nada". Se a folha de pagamento não carregar mas as
// faturas sim, o utilizador vê **custos a zero** e uma **margem inflacionada**,
// com o mesmo aspecto de um mês sem despesas.
//
// Este módulo compõe, a partir do que a T14 já apura, um objecto que a futura
// interface pode usar para dizer "dados incompletos" em vez de mostrar números
// falsos. **Não implementa visual nenhum** — é só o contrato.

import {
  type IntegrityIssue,
  type ReportCompleteness,
  type ReportSource,
  type SourceOutcome,
  countByCode,
} from "../reports/integrity";

export interface FinancialDataHealth {
  completeness: ReportCompleteness;
  /** `true` só quando `completeness === "COMPLETE"` e não há ERROR. */
  trustworthy: boolean;
  issuesCount: number;
  /** Problemas de gravidade `ERROR`. São estes que desaconselham decidir. */
  criticalCount: number;
  /** Fontes que não carregaram. Vazio quando está tudo bem. */
  sourcesUnavailable: ReportSource[];
  /** Fontes que nem chegaram a ser pedidas. Não é degradação. */
  sourcesNotRequested: ReportSource[];
  /** Contagem por código, para a UI poder agrupar. */
  byCode: Partial<Record<IntegrityIssue["code"], number>>;
  /** Instante de construção, vindo de fora. `null` = desconhecido. */
  generatedAt: string | null;
  /** Frescura dos dados. `null` = **desconhecida**. Nunca fingir tempo real. */
  freshestSourceAt: string | null;
}

export function buildDataHealth(input: {
  completeness: ReportCompleteness;
  sources: readonly SourceOutcome[];
  issues: readonly IntegrityIssue[];
  generatedAt: string | null;
  freshestSourceAt: string | null;
}): FinancialDataHealth {
  const criticalCount = input.issues.filter((i) => i.severity === "ERROR").length;
  return {
    completeness: input.completeness,
    trustworthy: input.completeness === "COMPLETE" && criticalCount === 0,
    issuesCount: input.issues.length,
    criticalCount,
    sourcesUnavailable: input.sources.filter((s) => s.status === "FAILED").map((s) => s.source),
    sourcesNotRequested: input.sources.filter((s) => s.status === "NOT_REQUESTED").map((s) => s.source),
    byCode: countByCode(input.issues),
    generatedAt: input.generatedAt,
    freshestSourceAt: input.freshestSourceAt,
  };
}

/**
 * Junta a saúde de vários períodos (o dashboard mostra mês, ano e 12 meses ao
 * mesmo tempo). O agregado assume sempre o estado **mais fraco**: se um dos
 * blocos está degradado, o cabeçalho do dashboard tem de o dizer.
 */
export function mergeDataHealth(
  parts: readonly FinancialDataHealth[],
): FinancialDataHealth {
  if (parts.length === 0) {
    return {
      completeness: "FAILED",
      trustworthy: false,
      issuesCount: 0,
      criticalCount: 0,
      sourcesUnavailable: [],
      sourcesNotRequested: [],
      byCode: {},
      generatedAt: null,
      freshestSourceAt: null,
    };
  }

  const completeness: ReportCompleteness = parts.some((p) => p.completeness === "FAILED")
    ? "FAILED"
    : parts.some((p) => p.completeness === "PARTIAL")
      ? "PARTIAL"
      : "COMPLETE";

  const unavailable = new Set<ReportSource>();
  const notRequested = new Set<ReportSource>();
  const byCode: Partial<Record<IntegrityIssue["code"], number>> = {};
  let issuesCount = 0;
  let criticalCount = 0;
  let generatedAt: string | null = null;
  let freshestSourceAt: string | null = null;

  for (const p of parts) {
    for (const s of p.sourcesUnavailable) unavailable.add(s);
    for (const s of p.sourcesNotRequested) notRequested.add(s);
    for (const [code, count] of Object.entries(p.byCode)) {
      const key = code as IntegrityIssue["code"];
      byCode[key] = (byCode[key] ?? 0) + (count ?? 0);
    }
    issuesCount += p.issuesCount;
    criticalCount += p.criticalCount;
    if (p.generatedAt != null && (generatedAt == null || p.generatedAt > generatedAt)) {
      generatedAt = p.generatedAt;
    }
    // A frescura do conjunto é a do dado MAIS ANTIGO: dizer que o dashboard
    // está fresco porque uma das fontes é recente seria a mesma mentira que
    // mostrar zeros por uma consulta falhada.
    if (p.freshestSourceAt != null
      && (freshestSourceAt == null || p.freshestSourceAt < freshestSourceAt)) {
      freshestSourceAt = p.freshestSourceAt;
    }
  }

  return {
    completeness,
    trustworthy: completeness === "COMPLETE" && criticalCount === 0,
    issuesCount,
    criticalCount,
    sourcesUnavailable: [...unavailable].sort(),
    sourcesNotRequested: [...notRequested].sort(),
    byCode,
    generatedAt,
    freshestSourceAt,
  };
}
