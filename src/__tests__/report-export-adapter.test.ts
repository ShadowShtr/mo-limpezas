// T14 — Adaptador de exportação.
//
// A regra que estes testes protegem: a exportação consome o MESMO DTO do ecrã e
// não refaz nenhuma conta. Hoje o CSV e o PDF dos Relatórios recalculam o IVA no
// browser (`total_receita * (1 + vatFactor)`), sobre a soma já agregada do
// cliente, ignorando o `apply_vat` linha a linha.

import { describe, it, expect } from "vitest";
import {
  amountToCsvCell,
  centsToCsvCell,
  completenessTag,
  exportDailySeries,
  exportFinancialSummary,
  exportIntegrityIssues,
  exportOperations,
  exportProvenance,
  exportVatBreakdown,
} from "@/domain/reports/export-adapter";
import {
  buildDailySeries,
  buildReport,
  type ReportInput,
} from "@/domain/reports/report-read-model";
import { sourceFailed, sourceOk } from "@/domain/reports/integrity";
import { monthPeriod } from "@/domain/reports/period";
import { eurosToCents } from "@/domain/billing/money";
import { amount, unavailable } from "@/domain/billing/financial-model";
import type {
  CashFlowInput,
  InvoiceInput,
  PayrollInput,
  ServiceInput,
} from "@/domain/reports/report-sources";

const AGOSTO = monthPeriod(2026, 8)!;
const cents = (v: number) => eurosToCents(v)!;

const INPUT: ReportInput = {
  window: AGOSTO,
  asOf: "2026-08-31",
  generatedAt: "2026-08-31T18:00:00Z",
  freshestSourceAt: "2026-08-31T17:45:00Z",
  sources: {
    services: sourceOk<ServiceInput>([
      {
        id: "s1", occurrenceDate: "2026-08-05", status: "concluido", contractId: null,
        valueCents: cents(100), applyVat: true, workedMinutes: 120, scheduledMinutes: 120,
      },
      {
        id: "s2", occurrenceDate: "2026-08-06", status: "concluido", contractId: null,
        valueCents: cents(50), applyVat: false, workedMinutes: 60, scheduledMinutes: 60,
      },
    ]),
    contracts: sourceOk([]),
    invoices: sourceOk<InvoiceInput>([{
      id: "i1", periodStart: "2026-08-01", dueDate: "2026-09-30",
      netCents: cents(150), vatCents: cents(23), grossCents: cents(173),
      vatRatePct: 23, status: "pendente", itemCount: 2,
    }]),
    cashFlow: sourceOk<CashFlowInput>([{
      id: "cf1", date: "2026-08-20", type: "entrada",
      amountCents: cents(73), category: "faturacao", status: "confirmado",
    }]),
    payroll: sourceOk<PayrollInput>([]),
    timesheets: sourceOk([]),
    absences: sourceOk([]),
    vat: sourceOk([{ ratePct: 23 }]),
  },
};

const REPORT = buildReport(INPUT);

describe("células", () => {
  it("cêntimos viram euros com duas casas", () => {
    expect(centsToCsvCell(cents(123.45))).toBe("123.45");
    expect(centsToCsvCell(cents(0))).toBe("0.00");
  });

  it("null é célula vazia, nunca 0,00", () => {
    // Um zero num CSV que vai para a contabilidade é uma afirmação.
    expect(centsToCsvCell(null)).toBe("");
    expect(amountToCsvCell(unavailable("invoice", "não carregado"))).toBe("");
  });

  it("um zero legítimo continua a ser 0.00", () => {
    expect(amountToCsvCell(amount(cents(0), "invoice"))).toBe("0.00");
  });

  it("a marca de completude distingue os três estados", () => {
    expect(completenessTag(amount(cents(1), "invoice", "COMPLETE"))).toBe("");
    expect(completenessTag(amount(cents(1), "invoice", "PARTIAL"))).toBe("parcial");
    expect(completenessTag(unavailable("invoice", "x"))).toBe("indisponível");
  });
});

describe("exportFinancialSummary", () => {
  const tabela = exportFinancialSummary(REPORT);

  it("tem uma linha por conceito canónico, sempre pela mesma ordem", () => {
    expect(tabela.rows.map((r) => r[0])).toEqual([
      "Contratado", "Agendado", "Realizado", "Faturado", "Recebido",
      "Em aberto", "Vencido", "Despesas", "Folha", "Custos",
      "Margem (base: invoiced)",
    ]);
  });

  it("os valores vêm do DTO, sem nenhum recálculo", () => {
    const linha = (nome: string) => tabela.rows.find((r) => r[0] === nome)!;
    expect(linha("Faturado")[1]).toBe(centsToCsvCell(REPORT.financial.invoiced.cents));
    expect(linha("Recebido")[1]).toBe(centsToCsvCell(REPORT.financial.received.cents));
    expect(linha("Em aberto")[1]).toBe(centsToCsvCell(REPORT.financial.outstanding.cents));
  });

  it("não há avisos quando o relatório está completo", () => {
    expect(tabela.notices).toHaveLength(0);
  });
});

describe("exportVatBreakdown", () => {
  it("base + IVA = total, sem refazer a conta no ficheiro", () => {
    const t = exportVatBreakdown(REPORT);
    const [net, vat, gross] = t.rows[0];
    expect(Number(net) + Number(vat)).toBeCloseTo(Number(gross), 10);
  });

  it("respeita o apply_vat de cada linha, ao contrário do CSV actual", () => {
    // 100 € com IVA (23 €) + 50 € isentos = 150 € base, 23 € de IVA.
    // O CSV actual faria 150 × 0,23 = 34,50 € de IVA sobre a soma.
    const t = exportVatBreakdown(REPORT);
    expect(t.rows[0][0]).toBe("150.00");
    expect(t.rows[0][1]).toBe("23.00");
    expect(t.rows[0][2]).toBe("173.00");
  });

  it("taxa indisponível fica em branco, não 23", () => {
    const semTaxa = buildReport({
      ...INPUT,
      sources: { ...INPUT.sources, vat: sourceOk([{ ratePct: null }]) },
    });
    expect(exportVatBreakdown(semTaxa).rows[0][3]).toBe("");
  });
});

describe("exportDailySeries", () => {
  const daily = buildDailySeries(INPUT);
  const t = exportDailySeries(REPORT, daily);

  it("tem uma linha por dia, incluindo os vazios", () => {
    expect(t.rows).toHaveLength(31);
    expect(t.rows[0][0]).toBe("2026-08-01");
  });

  it("um dia sem serviços aparece com zeros em vez de desaparecer", () => {
    const dia1 = t.rows[0];
    expect(dia1[1]).toBe("0");
    expect(dia1[5]).toBe("0.00");
  });

  it("a soma da coluna de realizado bate com o total do mês", () => {
    const soma = t.rows.reduce((acc, r) => acc + Number(r[5]), 0);
    expect(soma).toBeCloseTo(Number(centsToCsvCell(REPORT.financial.performed.cents)), 10);
  });
});

describe("exportOperations", () => {
  it("dá um contador por estado, sem baldes", () => {
    const t = exportOperations(REPORT);
    const nomes = t.rows.map((r) => r[0]);
    expect(nomes).toContain("Em curso");
    expect(nomes).toContain("Sem cobertura");
    expect(nomes).toContain("Estado desconhecido");
  });

  it("horas sem base ficam em branco, não a zero", () => {
    const t = exportOperations(REPORT);
    const ausencia = t.rows.find((r) => r[0] === "Horas de ausência")!;
    expect(ausencia[1]).toBe("");
  });
});

describe("relatório degradado", () => {
  const degradado = buildReport({
    ...INPUT,
    sources: { ...INPUT.sources, payroll: sourceFailed<PayrollInput>("timeout") },
  });

  it("o ficheiro leva o aviso no topo", () => {
    const t = exportFinancialSummary(degradado);
    expect(t.notices.join(" ")).toContain("PARTIAL");
    expect(t.notices.join(" ")).toContain("payroll_records");
  });

  it("o valor da fonte que falhou fica em branco, não a zero", () => {
    const t = exportFinancialSummary(degradado);
    const folha = t.rows.find((r) => r[0] === "Folha")!;
    expect(folha[1]).toBe("");
    expect(folha[2]).toBe("indisponível");
  });

  it("os problemas de integridade têm a sua própria tabela", () => {
    const t = exportIntegrityIssues(degradado);
    expect(t.rows.map((r) => r[1])).toContain("PAYROLL_QUERY_FAILED");
  });

  it("a tabela de problemas nunca leva a mensagem do driver, só a nossa nota", () => {
    const t = exportIntegrityIssues(degradado);
    for (const r of t.rows) {
      expect(r[4]).not.toMatch(/PGRST|supabase|postgres/i);
    }
  });
});

describe("exportProvenance", () => {
  it("diz o período, quando foi gerado e a frescura", () => {
    const linhas = exportProvenance(REPORT);
    expect(linhas[0]).toContain("2026-08-01");
    expect(linhas[2]).toContain("2026-08-31T18:00:00Z");
    expect(linhas[3]).toContain("2026-08-31T17:45:00Z");
  });

  it("frescura desconhecida diz-se, não se finge tempo real", () => {
    const semRelogio = buildReport({ ...INPUT, generatedAt: undefined, freshestSourceAt: null });
    const linhas = exportProvenance(semRelogio);
    expect(linhas[2]).toContain("desconhecido");
    expect(linhas[3]).toContain("desconhecido");
  });
});
