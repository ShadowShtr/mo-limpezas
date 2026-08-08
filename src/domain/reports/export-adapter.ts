// ============================================================================
// T14 — Adaptador de exportação (CSV / PDF)
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Formata um DTO já construído. Não lê a base, não escreve, não
// calcula dinheiro. Nada aqui altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// O defeito que isto fecha.
//
// A exportação recalcula. Em
// `src/app/(dashboard)/dashboard/relatorios/_components/reports-tabs.tsx`:
//
//     exportCsv(..., [
//       a base vinda do servidor, com toFixed(2);
//       a base multiplicada pelo vatFactor do BROWSER  → IVA refeito;
//       a base multiplicada por (1 + esse mesmo fator) → total refeito
//     ])
//
// e outra vez no PDF (`exportClientePdf`), com o seu próprio `vatFactor`.
//
// Três consequências:
//
//   1. o CSV e o ecrã podem discordar em cêntimos, porque o servidor arredondou
//      uma vez e o browser arredonda outra, sobre um total já somado;
//   2. o IVA do CSV é calculado sobre a soma do cliente e ignora o `apply_vat`
//      linha a linha — um cliente com serviços isentos e não isentos leva IVA a
//      mais no ficheiro que vai para a contabilidade;
//   3. qualquer correcção futura ao IVA tem de ser feita em três sítios.
//
// A regra da T14: **a exportação não faz contas.** Recebe o mesmo DTO do ecrã e
// converte cêntimos em texto. Se um número não está no DTO, falta um campo no
// contrato — não é a exportação que o deve inventar.
//
// Este módulo NÃO gera ficheiros. Produz linhas. A geração real de CSV/PDF
// continua onde está (`src/lib/csv.ts`, `jspdf`), e ligá-la a isto é trabalho
// de integração — fora do âmbito offline da T14.

import { type MoneyCents, centsToEuros } from "../billing/money";
import { type FinancialAmount } from "../billing/financial-model";
import { type DailyReportPoint, type ReportReadModel } from "./report-read-model";

/**
 * Como um montante aparece num ficheiro exportado.
 *
 * `null` é `""` — célula vazia — e nunca `"0,00"`. Um zero num CSV que vai para
 * a contabilidade é uma afirmação; uma célula vazia é a ausência de afirmação.
 * Confundir os dois é o mesmo defeito que o `?? []` das consultas, noutro sítio.
 */
export function centsToCsvCell(cents: MoneyCents | null): string {
  if (cents == null) return "";
  const euros = centsToEuros(cents);
  return euros == null ? "" : euros.toFixed(2);
}

/** Idem, para um `FinancialAmount`: respeita `UNAVAILABLE`. */
export function amountToCsvCell(value: FinancialAmount): string {
  if (value.completeness === "UNAVAILABLE") return "";
  return centsToCsvCell(value.cents);
}

/**
 * Marca de completude para a célula ao lado, quando a exportação a quiser.
 * Texto curto e estável, não para tradução.
 */
export function completenessTag(value: FinancialAmount): string {
  switch (value.completeness) {
    case "COMPLETE": return "";
    case "PARTIAL": return "parcial";
    case "UNAVAILABLE": return "indisponível";
  }
}

// ─── Resumo financeiro ──────────────────────────────────────────────────────

export interface ExportTable {
  /** Cabeçalho do ficheiro. */
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  /**
   * Avisos a imprimir no topo do ficheiro quando o relatório está degradado.
   * Um CSV sem esta linha, gerado a partir de um relatório `PARTIAL`, parece um
   * relatório completo assim que sai da aplicação.
   */
  notices: readonly string[];
}

function noticesOf(report: ReportReadModel): string[] {
  const out: string[] = [];
  if (report.metadata.completeness !== "COMPLETE") {
    out.push(
      `ATENÇÃO: relatório ${report.metadata.completeness} — `
      + `${report.metadata.integrityIssues.length} problema(s) de integridade`,
    );
    for (const s of report.metadata.sources) {
      if (s.status === "FAILED") out.push(`fonte indisponível: ${s.source}`);
    }
  }
  if (report.financial.vatRatePct == null) {
    out.push("taxa de IVA indisponível — nenhum valor assumido");
  }
  return out;
}

/**
 * Resumo financeiro do período, uma linha por conceito.
 *
 * A ordem é a do modelo canónico da T11 e não muda: quem lê dois ficheiros de
 * meses diferentes compara linha a linha.
 */
export function exportFinancialSummary(report: ReportReadModel): ExportTable {
  const f = report.financial;
  const rows: string[][] = [
    ["Contratado", amountToCsvCell(f.contracted), completenessTag(f.contracted)],
    ["Agendado", amountToCsvCell(f.scheduled), completenessTag(f.scheduled)],
    ["Realizado", amountToCsvCell(f.performed), completenessTag(f.performed)],
    ["Faturado", amountToCsvCell(f.invoiced), completenessTag(f.invoiced)],
    ["Recebido", amountToCsvCell(f.received), completenessTag(f.received)],
    ["Em aberto", amountToCsvCell(f.outstanding), completenessTag(f.outstanding)],
    ["Vencido", amountToCsvCell(f.overdue), completenessTag(f.overdue)],
    ["Despesas", amountToCsvCell(f.expenses), completenessTag(f.expenses)],
    ["Folha", amountToCsvCell(f.payroll), completenessTag(f.payroll)],
    ["Custos", amountToCsvCell(f.cost), completenessTag(f.cost)],
    [`Margem (base: ${f.marginBasis})`, amountToCsvCell(f.margin), completenessTag(f.margin)],
  ];

  return {
    headers: ["Conceito", "Valor (€)", "Estado"],
    rows,
    notices: noticesOf(report),
  };
}

/**
 * Decomposição fiscal do realizado.
 *
 * As três parcelas vêm do `VatBreakdown` da T11, onde `net + vat = gross` é
 * invariante. O ficheiro nunca refaz a conta — é essa a diferença face ao CSV
 * actual.
 */
export function exportVatBreakdown(report: ReportReadModel): ExportTable {
  const v = report.financial.vat;
  const rate = report.financial.vatRatePct;
  return {
    headers: ["Base (€)", "IVA (€)", "Total (€)", "Taxa (%)"],
    rows: [[
      centsToCsvCell(v.netCents),
      centsToCsvCell(v.vatCents),
      centsToCsvCell(v.grossCents),
      rate == null ? "" : String(rate),
    ]],
    notices: noticesOf(report),
  };
}

/** Série diária, um dia por linha, incluindo os dias vazios. */
export function exportDailySeries(
  monthly: ReportReadModel,
  daily: readonly DailyReportPoint[],
): ExportTable {
  return {
    headers: [
      "Data",
      "Serviços",
      "Concluídos",
      "Cancelados",
      "Agendado (€)",
      "Realizado (€)",
      "Faturado (€)",
      "Recebido (€)",
    ],
    rows: daily.map((point) => {
      const f = point.report.financial;
      const o = point.report.operations;
      return [
        point.date,
        String(o.counts.total),
        String(o.completed),
        String(o.cancelled),
        amountToCsvCell(f.scheduled),
        amountToCsvCell(f.performed),
        amountToCsvCell(f.invoiced),
        amountToCsvCell(f.received),
      ];
    }),
    notices: noticesOf(monthly),
  };
}

/** Métricas operacionais do período. */
export function exportOperations(report: ReportReadModel): ExportTable {
  const o = report.operations;
  const hours = (h: { hours: number | null }) => (h.hours == null ? "" : h.hours.toFixed(2));
  return {
    headers: ["Métrica", "Valor"],
    rows: [
      ["Serviços (total)", String(o.counts.total)],
      ["Agendados", String(o.counts.agendado)],
      ["Em curso", String(o.counts.em_curso)],
      ["Concluídos", String(o.counts.concluido)],
      ["Cancelados", String(o.counts.cancelado)],
      ["Faltas", String(o.counts.falta)],
      ["Sem cobertura", String(o.counts.sem_cobertura)],
      ["Estado desconhecido", String(o.counts.unknown)],
      ["Horas planeadas", hours(o.scheduledHours)],
      ["Horas trabalhadas", hours(o.workedHours)],
      ["Horas de ausência", hours(o.absenceHours)],
      ["Dias de ausência", o.absenceDays == null ? "" : String(o.absenceDays)],
    ],
    notices: noticesOf(report),
  };
}

/** Problemas de integridade, para que a exportação os leve consigo. */
export function exportIntegrityIssues(report: ReportReadModel): ExportTable {
  return {
    headers: ["Gravidade", "Código", "Fonte", "Referência", "Detalhe"],
    rows: report.metadata.integrityIssues.map((i) => [
      i.severity,
      i.code,
      i.source ?? "",
      i.subject ?? "",
      i.detail ?? "",
    ]),
    notices: noticesOf(report),
  };
}

/**
 * Cabeçalho de proveniência, para o topo de qualquer ficheiro exportado.
 *
 * Diz de que período é, quando foi gerado e qual a frescura dos dados. Sem
 * isto, um CSV guardado numa pasta é indistinguível de outro do mesmo mês
 * gerado antes de uma correcção.
 */
export function exportProvenance(report: ReportReadModel): readonly string[] {
  const m = report.metadata;
  return [
    `Período: ${m.period.start} a ${m.period.end}`,
    `Referência de vencimento: ${m.asOf}`,
    `Gerado em: ${m.generatedAt ?? "desconhecido"}`,
    `Dados mais recentes de: ${m.freshestSourceAt ?? "desconhecido"}`,
    `Completude: ${m.completeness}`,
  ];
}
