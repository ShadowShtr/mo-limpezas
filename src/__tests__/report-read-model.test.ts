// T14 — Read model canónico dos relatórios.
//
// Cobre as quatro regras da task:
//
//   • falha de consulta NUNCA vira zero;
//   • REALIZADO ≠ FATURADO ≠ RECEBIDO, com prova;
//   • o denominador da avença vem sempre do mês inteiro;
//   • o mês usa a mesma fórmula do dia, e a soma dos dias fecha.

import { describe, it, expect } from "vitest";
import {
  type MonthlyOccurrenceSet,
  type ReportInput,
  ADDITIVE_CONCEPTS,
  NON_ADDITIVE_CONCEPTS,
  buildDailySeries,
  buildReport,
  checkDailyMonthlyParity,
  collectSeriesIssues,
  sumDailyOperations,
} from "@/domain/reports/report-read-model";
import { sourceFailed, sourceOk } from "@/domain/reports/integrity";
import { dayPeriod, monthPeriod } from "@/domain/reports/period";
import type {
  AbsenceInput,
  CashFlowInput,
  ContractInput,
  InvoiceInput,
  PayrollInput,
  ServiceInput,
  TimesheetInput,
} from "@/domain/reports/report-sources";
import { eurosToCents } from "@/domain/billing/money";

const AGOSTO = monthPeriod(2026, 8)!;
const cents = (v: number) => eurosToCents(v)!;
const CONTRATO = "contrato-1";

function svc(over: Partial<ServiceInput> = {}): ServiceInput {
  return {
    id: "s1",
    occurrenceDate: "2026-08-05",
    status: "concluido",
    contractId: null,
    valueCents: cents(100),
    applyVat: false,
    workedMinutes: null,
    scheduledMinutes: 120,
    ...over,
  };
}

function contrato(over: Partial<ContractInput> = {}): ContractInput {
  return {
    id: CONTRATO,
    fixedMonthly: true,
    fixedPriceCents: cents(300),
    applyVat: false,
    startsOn: null,
    endsOn: null,
    status: "ativo",
    ...over,
  };
}

function fatura(over: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    id: "i1",
    periodStart: "2026-08-01",
    dueDate: "2026-08-31",
    netCents: cents(100),
    vatCents: cents(0),
    grossCents: cents(100),
    vatRatePct: 0,
    status: "pendente",
    itemCount: 1,
    ...over,
  };
}

function caixa(over: Partial<CashFlowInput> = {}): CashFlowInput {
  return {
    id: "cf1",
    date: "2026-08-10",
    type: "entrada",
    amountCents: cents(100),
    category: "faturacao",
    status: "confirmado",
    ...over,
  };
}

function base(over: Partial<ReportInput> = {}): ReportInput {
  return {
    window: AGOSTO,
    asOf: "2026-08-31",
    sources: {
      services: sourceOk<ServiceInput>([]),
      contracts: sourceOk<ContractInput>([]),
      invoices: sourceOk<InvoiceInput>([]),
      cashFlow: sourceOk<CashFlowInput>([]),
      payroll: sourceOk<PayrollInput>([]),
      timesheets: sourceOk<TimesheetInput>([]),
      absences: sourceOk<AbsenceInput>([]),
      vat: sourceOk([{ ratePct: 23 }]),
    },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("cenário 1 — mês vazio", () => {
  const r = buildReport(base());

  it("é COMPLETE: não há dados porque não houve nada, e isso sabe-se", () => {
    expect(r.metadata.completeness).toBe("COMPLETE");
  });

  it("os valores são zero — zero legítimo, com cents definidos", () => {
    expect(r.financial.performed.cents).toBe(0);
    expect(r.financial.performed.completeness).toBe("COMPLETE");
    expect(r.financial.invoiced.cents).toBe(0);
    expect(r.financial.received.cents).toBe(0);
  });

  it("não há problemas de integridade", () => {
    expect(r.metadata.integrityIssues).toHaveLength(0);
  });
});

describe("cenário 20 — fonte que falha nunca vira zero", () => {
  it("uma consulta falhada torna o valor UNAVAILABLE, não 0", () => {
    const r = buildReport(base({
      sources: { ...base().sources, invoices: sourceFailed<InvoiceInput>("timeout") },
    }));
    expect(r.financial.invoiced.cents).toBeNull();
    expect(r.financial.invoiced.completeness).toBe("UNAVAILABLE");
  });

  it("regista o código estável da fonte", () => {
    const r = buildReport(base({
      sources: { ...base().sources, invoices: sourceFailed<InvoiceInput>("timeout") },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("INVOICES_QUERY_FAILED");
  });

  it("o relatório fica PARTIAL, não COMPLETE", () => {
    const r = buildReport(base({
      sources: { ...base().sources, payroll: sourceFailed<PayrollInput>() },
    }));
    expect(r.metadata.completeness).toBe("PARTIAL");
  });

  it("todas as fontes falhadas → FAILED", () => {
    const r = buildReport(base({
      sources: {
        services: sourceFailed<ServiceInput>(),
        contracts: sourceFailed<ContractInput>(),
        invoices: sourceFailed<InvoiceInput>(),
        cashFlow: sourceFailed<CashFlowInput>(),
        payroll: sourceFailed<PayrollInput>(),
        timesheets: sourceFailed<TimesheetInput>(),
        absences: sourceFailed<AbsenceInput>(),
        vat: sourceFailed(),
      },
    }));
    expect(r.metadata.completeness).toBe("FAILED");
    for (const key of ["contracted", "scheduled", "performed", "invoiced", "received", "cost"] as const) {
      expect(r.financial[key].cents).toBeNull();
    }
  });

  it("a margem herda a indisponibilidade da parcela mais fraca", () => {
    const r = buildReport(base({
      marginBasis: "invoiced",
      sources: { ...base().sources, payroll: sourceFailed<PayrollInput>(), cashFlow: sourceFailed<CashFlowInput>() },
    }));
    expect(r.financial.cost.cents).toBeNull();
    expect(r.financial.margin.cents).toBeNull();
  });

  it("uma fonte não pedida não degrada o relatório", () => {
    const r = buildReport({
      window: AGOSTO,
      asOf: "2026-08-31",
      sources: { services: sourceOk<ServiceInput>([]) },
    });
    expect(r.metadata.completeness).toBe("COMPLETE");
    expect(r.metadata.sources.filter((s) => s.status === "NOT_REQUESTED").length).toBeGreaterThan(0);
  });

  it("taxa de IVA indisponível não assume 23%", () => {
    // O código actual faz `settingsRow?.vat_rate ?? 23` em cinco sítios.
    const r = buildReport(base({ sources: { ...base().sources, vat: sourceOk([{ ratePct: null }]) } }));
    expect(r.financial.vatRatePct).toBeNull();
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("VAT_RATE_UNAVAILABLE");
  });
});

describe("cenário 2 — serviço avulso", () => {
  const r = buildReport(base({
    sources: { ...base().sources, services: sourceOk([svc({ valueCents: cents(80) })]) },
  }));

  it("entra no realizado e no agendado", () => {
    expect(r.financial.performed.cents).toBe(cents(80));
    expect(r.financial.scheduled.cents).toBe(cents(80));
  });

  it("não entra no faturado nem no recebido", () => {
    expect(r.financial.invoiced.cents).toBe(0);
    expect(r.financial.received.cents).toBe(0);
  });
});

describe("cenário 16 — avença sem visita concluída", () => {
  const monthly: MonthlyOccurrenceSet[] = [{
    contractId: CONTRATO,
    monthKey: "2026-08",
    occurrences: [
      { id: "o1", occurrenceDate: "2026-08-05", status: "agendado" },
      { id: "o2", occurrenceDate: "2026-08-19", status: "agendado" },
    ],
  }];

  const r = buildReport(base({
    monthlyOccurrences: monthly,
    sources: {
      ...base().sources,
      contracts: sourceOk([contrato()]),
      services: sourceOk([
        svc({ id: "o1", status: "agendado", contractId: CONTRATO, valueCents: cents(0) }),
        svc({ id: "o2", occurrenceDate: "2026-08-19", status: "agendado", contractId: CONTRATO, valueCents: cents(0) }),
      ]),
    },
  }));

  it("contratado é maior que zero mesmo sem nenhuma visita concluída", () => {
    // A "avença invisível": o relatório antigo mostra 0 € de receita.
    expect(r.financial.contracted.cents).toBe(cents(300));
  });

  it("realizado é zero — nada foi concluído", () => {
    expect(r.financial.performed.cents).toBe(0);
  });

  it("agendado é o valor mensal inteiro, distribuído pelas ocorrências", () => {
    expect(r.financial.scheduled.cents).toBe(cents(300));
  });

  it("faturado segue as faturas, não a avença", () => {
    expect(r.financial.invoiced.cents).toBe(0);
  });

  it("nada de receita inventada", () => {
    expect(r.financial.received.cents).toBe(0);
  });
});

describe("cenário 3 — avença com distribuição de cêntimos", () => {
  function avencaDe(price: number, count: number, status = "concluido") {
    const occurrences = Array.from({ length: count }, (_, i) => ({
      id: `o${i}`,
      occurrenceDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
      status: status as "concluido",
    }));
    return buildReport(base({
      monthlyOccurrences: [{ contractId: CONTRATO, monthKey: "2026-08", occurrences }],
      sources: {
        ...base().sources,
        contracts: sourceOk([contrato({ fixedPriceCents: cents(price) })]),
        services: sourceOk(occurrences.map((o) => svc({
          id: o.id, occurrenceDate: o.occurrenceDate, status, contractId: CONTRATO, valueCents: cents(0),
        }))),
      },
    }));
  }

  it("100,00 € em 3 ocorrências fecha nos 100,00 € — nem um cêntimo perdido", () => {
    // O código actual dá 33,33 × 3 = 99,99 €.
    expect(avencaDe(100, 3).financial.performed.cents).toBe(cents(100));
  });

  it("99,99 € em 31 ocorrências fecha exactamente", () => {
    expect(avencaDe(99.99, 31).financial.performed.cents).toBe(cents(99.99));
  });

  it("fecha para qualquer combinação de valor e contagem", () => {
    for (const price of [100, 99.99, 300, 250.5, 1]) {
      for (const count of [1, 2, 3, 7, 13, 28]) {
        expect(avencaDe(price, count).financial.performed.cents).toBe(cents(price));
      }
    }
  });
});

describe("o denominador da avença vem do mês inteiro", () => {
  // O defeito §4.3 da T11: numa semana a cavalo de dois meses, o dashboard
  // conta o denominador só com o que tem em memória e inflaciona o valor.
  const occurrences = [
    { id: "o1", occurrenceDate: "2026-08-01", status: "concluido" as const },
    { id: "o2", occurrenceDate: "2026-08-15", status: "concluido" as const },
    { id: "o3", occurrenceDate: "2026-08-29", status: "concluido" as const },
  ];
  const monthly: MonthlyOccurrenceSet[] = [{ contractId: CONTRATO, monthKey: "2026-08", occurrences }];

  it("uma janela de um dia usa o denominador do mês, não o do dia", () => {
    const r = buildReport(base({
      window: dayPeriod("2026-08-01")!,
      monthlyOccurrences: monthly,
      sources: {
        ...base().sources,
        contracts: sourceOk([contrato({ fixedPriceCents: cents(300) })]),
        services: sourceOk([svc({ id: "o1", occurrenceDate: "2026-08-01", contractId: CONTRATO, valueCents: cents(0) })]),
      },
    }));
    // 300 ÷ 3 = 100, e não 300 ÷ 1 = 300.
    expect(r.financial.performed.cents).toBe(cents(100));
  });

  it("sem o conjunto mensal, assinala PARTIAL_MONTH_WINDOW em vez de dividir mal", () => {
    const r = buildReport(base({
      window: dayPeriod("2026-08-01")!,
      monthlyOccurrences: [],
      sources: {
        ...base().sources,
        contracts: sourceOk([contrato()]),
        services: sourceOk([svc({ id: "o1", occurrenceDate: "2026-08-01", contractId: CONTRATO, valueCents: cents(0) })]),
      },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("PARTIAL_MONTH_WINDOW");
    expect(r.financial.performed.completeness).toBe("PARTIAL");
  });

  it("avença com valor e zero ocorrências não divide por zero nem inventa receita", () => {
    const r = buildReport(base({
      monthlyOccurrences: [{ contractId: CONTRATO, monthKey: "2026-08", occurrences: [] }],
      sources: { ...base().sources, contracts: sourceOk([contrato()]) },
    }));
    expect(r.financial.performed.cents).toBe(0);
    expect(r.financial.contracted.cents).toBe(cents(300));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("UNALLOCATED_MONTHLY_AMOUNT");
  });
});

describe("cenários 7 e 8 — cancelamento e falta na avença", () => {
  const occurrences = [
    { id: "o1", occurrenceDate: "2026-08-01", status: "concluido" as const },
    { id: "o2", occurrenceDate: "2026-08-08", status: "falta" as const },
    { id: "o3", occurrenceDate: "2026-08-15", status: "cancelado" as const },
  ];
  const r = buildReport(base({
    monthlyOccurrences: [{ contractId: CONTRATO, monthKey: "2026-08", occurrences }],
    sources: {
      ...base().sources,
      contracts: sourceOk([contrato({ fixedPriceCents: cents(200) })]),
      services: sourceOk(occurrences.map((o) => svc({
        id: o.id, occurrenceDate: o.occurrenceDate, status: o.status, contractId: CONTRATO, valueCents: cents(0),
      }))),
    },
  }));

  it("cancelado sai do agendado; falta continua a ocupar", () => {
    expect(r.operations.cancelled).toBe(1);
    expect(r.operations.absences).toBe(1);
    expect(r.operations.scheduled).toBe(2);
  });

  it("o agendado distribui pelos dois não cancelados e fecha no valor do contrato", () => {
    expect(r.financial.scheduled.cents).toBe(cents(200));
  });

  it("o realizado distribui só pelo concluído e também fecha", () => {
    expect(r.financial.performed.cents).toBe(cents(200));
  });
});

describe("cenários 10 a 13 — faturado, recebido, em aberto, vencido", () => {
  it("faturado não conta rascunhos nem canceladas", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        invoices: sourceOk([
          fatura({ id: "i1", status: "pendente", grossCents: cents(100) }),
          fatura({ id: "i2", status: "rascunho", grossCents: cents(500) }),
          fatura({ id: "i3", status: "cancelado", grossCents: cents(900) }),
        ]),
      },
    }));
    expect(r.financial.invoiced.cents).toBe(cents(100));
  });

  it("recebido vem da CAIXA, nunca de services.payment_status", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        // Um serviço concluído e "pago" não move o recebido por si só.
        services: sourceOk([svc({ valueCents: cents(500) })]),
        invoices: sourceOk([fatura({ grossCents: cents(500) })]),
        cashFlow: sourceOk([caixa({ amountCents: cents(200) })]),
      },
    }));
    expect(r.financial.performed.cents).toBe(cents(500));
    expect(r.financial.invoiced.cents).toBe(cents(500));
    expect(r.financial.received.cents).toBe(cents(200));
  });

  it("REALIZADO ≠ FATURADO ≠ RECEBIDO, e as três origens são distintas", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        services: sourceOk([svc({ valueCents: cents(500) })]),
        invoices: sourceOk([fatura({ grossCents: cents(300) })]),
        cashFlow: sourceOk([caixa({ amountCents: cents(100) })]),
      },
    }));
    expect(r.financial.performed.cents).not.toBe(r.financial.invoiced.cents);
    expect(r.financial.invoiced.cents).not.toBe(r.financial.received.cents);
    expect(r.financial.performed.origin).toBe("service_completed");
    expect(r.financial.invoiced.origin).toBe("invoice");
    expect(r.financial.received.origin).toBe("cash_flow");
  });

  it("em aberto é faturado menos recebido", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        invoices: sourceOk([fatura({ grossCents: cents(300) })]),
        cashFlow: sourceOk([caixa({ amountCents: cents(120) })]),
      },
    }));
    expect(r.financial.outstanding.cents).toBe(cents(180));
  });

  it("recebimento parcial aparece parcialmente em aberto", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        invoices: sourceOk([fatura({ status: "pendente", grossCents: cents(100) })]),
        cashFlow: sourceOk([caixa({ amountCents: cents(50) })]),
      },
    }));
    expect(r.financial.received.cents).toBe(cents(50));
    expect(r.financial.outstanding.cents).toBe(cents(50));
  });

  it("vencido é o emitido não pago cujo vencimento já passou", () => {
    const r = buildReport(base({
      asOf: "2026-08-20",
      sources: {
        ...base().sources,
        invoices: sourceOk([
          fatura({ id: "i1", dueDate: "2026-08-10", status: "pendente", grossCents: cents(100) }),
          fatura({ id: "i2", dueDate: "2026-08-30", status: "pendente", grossCents: cents(200) }),
          fatura({ id: "i3", dueDate: "2026-08-01", status: "pago", grossCents: cents(400) }),
        ]),
      },
    }));
    expect(r.financial.overdue.cents).toBe(cents(100));
  });

  it("o vencido depende do asOf, e não do relógio", () => {
    const build = (asOf: string) => buildReport(base({
      asOf,
      sources: { ...base().sources, invoices: sourceOk([fatura({ dueDate: "2026-08-15", status: "pendente" })]) },
    }));
    expect(build("2026-08-10").financial.overdue.cents).toBe(0);
    expect(build("2026-08-20").financial.overdue.cents).toBe(cents(100));
  });
});

describe("cenários 14 e 15 — despesa e folha", () => {
  it("despesa e folha somam nos custos sem dupla contagem", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        payroll: sourceOk([{ id: "p1", periodYear: 2026, periodMonth: 8, netSalaryCents: cents(1000), status: "pago" }]),
        cashFlow: sourceOk([
          caixa({ id: "cf1", type: "saida", category: "despesa", amountCents: cents(200) }),
          // Espelho da folha em caixa: NÃO pode entrar outra vez nos custos.
          caixa({ id: "cf2", type: "saida", category: "salario", amountCents: cents(1000) }),
        ]),
      },
    }));
    expect(r.financial.payroll.cents).toBe(cents(1000));
    expect(r.financial.expenses.cents).toBe(cents(200));
    expect(r.financial.cost.cents).toBe(cents(1200));
  });

  it("entradas pendentes não contam como recebidas", () => {
    const r = buildReport(base({
      sources: { ...base().sources, cashFlow: sourceOk([caixa({ status: "pendente" })]) },
    }));
    expect(r.financial.received.cents).toBe(0);
  });

  it("a margem declara a base usada", () => {
    const r = buildReport(base({
      marginBasis: "performed",
      sources: {
        ...base().sources,
        services: sourceOk([svc({ valueCents: cents(500) })]),
        payroll: sourceOk([{ id: "p1", periodYear: 2026, periodMonth: 8, netSalaryCents: cents(200), status: "pago" }]),
      },
    }));
    expect(r.financial.marginBasis).toBe("performed");
    expect(r.financial.margin.cents).toBe(cents(300));
  });

  it("mudar a base da margem muda o número, e isso é explícito", () => {
    const sources = {
      ...base().sources,
      services: sourceOk([svc({ valueCents: cents(500) })]),
      invoices: sourceOk([fatura({ grossCents: cents(300) })]),
      payroll: sourceOk([{ id: "p1", periodYear: 2026, periodMonth: 8, netSalaryCents: cents(100), status: "pago" }]),
    };
    expect(buildReport(base({ marginBasis: "performed", sources })).financial.margin.cents).toBe(cents(400));
    expect(buildReport(base({ marginBasis: "invoiced", sources })).financial.margin.cents).toBe(cents(200));
  });
});

describe("cenários 18 e 19 — contrato a meio do mês", () => {
  it("contrato que começa a meio conta o mês inteiro e assinala a decisão pendente", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ startsOn: "2026-08-15" })]) },
    }));
    // FULL_MONTH: a T14 não decide proporcionalidade. PRORATED está em standby.
    expect(r.financial.contracted.cents).toBe(cents(300));
    expect(r.financial.contracted.completeness).toBe("PARTIAL");
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("PARTIAL_MONTH_WINDOW");
  });

  it("contrato que termina a meio tem o mesmo tratamento", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ endsOn: "2026-08-15" })]) },
    }));
    expect(r.financial.contracted.cents).toBe(cents(300));
    expect(r.financial.contracted.completeness).toBe("PARTIAL");
  });

  it("contrato que cobre o mês inteiro fica COMPLETE", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ startsOn: "2026-01-01", endsOn: "2026-12-31" })]) },
    }));
    expect(r.financial.contracted.completeness).toBe("COMPLETE");
  });

  it("contrato fora da vigência não entra no contratado", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ startsOn: "2026-01-01", endsOn: "2026-03-31" })]) },
    }));
    expect(r.financial.contracted.cents).toBe(0);
  });

  it("contrato não ativo não entra", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ status: "cancelado" })]) },
    }));
    expect(r.financial.contracted.cents).toBe(0);
  });

  it("contrato sem fixed_price torna o contratado PARTIAL", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ fixedPriceCents: null })]) },
    }));
    expect(r.financial.contracted.completeness).toBe("PARTIAL");
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("MISSING_FINANCIAL_SOURCE");
  });

  it("um intervalo de vigência invertido é assinalado, não silenciado", () => {
    const r = buildReport(base({
      sources: { ...base().sources, contracts: sourceOk([contrato({ startsOn: "2026-08-20", endsOn: "2026-08-01" })]) },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("INVALID_DATE_RANGE");
  });
});

describe("problemas de integridade detectáveis offline", () => {
  it("INVOICED_WITHOUT_ITEMS", () => {
    const r = buildReport(base({
      sources: { ...base().sources, invoices: sourceOk([fatura({ itemCount: 0 })]) },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("INVOICED_WITHOUT_ITEMS");
  });

  it("subtotal + IVA ≠ total é assinalado", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        invoices: sourceOk([fatura({ netCents: cents(100), vatCents: cents(23), grossCents: cents(200) })]),
      },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("MONTHLY_ALLOCATION_MISMATCH");
  });

  it("RECEIVED_GT_INVOICED e NEGATIVE_OUTSTANDING andam juntos", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        invoices: sourceOk([fatura({ grossCents: cents(100) })]),
        cashFlow: sourceOk([caixa({ amountCents: cents(300) })]),
      },
    }));
    const codes = r.metadata.integrityIssues.map((i) => i.code);
    expect(codes).toContain("RECEIVED_GT_INVOICED");
    expect(codes).toContain("NEGATIVE_OUTSTANDING");
    expect(r.financial.outstanding.cents).toBe(cents(-200));
  });

  it("MISSING_FINANCIAL_SOURCE quando um serviço não tem valor nenhum", () => {
    const r = buildReport(base({
      sources: { ...base().sources, services: sourceOk([svc({ valueCents: null })]) },
    }));
    expect(r.metadata.integrityIssues.map((i) => i.code)).toContain("MISSING_FINANCIAL_SOURCE");
    expect(r.financial.performed.completeness).toBe("PARTIAL");
  });

  it("um problema nunca leva dados pessoais consigo", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        services: sourceOk([svc({ id: "s-x", status: "inventado" })]),
        invoices: sourceOk([fatura({ id: "i-x", itemCount: 0 })]),
      },
    }));
    for (const i of r.metadata.integrityIssues) {
      expect(i.subject == null || /^[\w@:.-]+$/.test(i.subject)).toBe(true);
    }
  });

  it("os problemas vêm ordenados por gravidade", () => {
    const r = buildReport(base({
      sources: {
        ...base().sources,
        payroll: sourceFailed<PayrollInput>(),
        invoices: sourceOk([fatura({ itemCount: 0 })]),
      },
    }));
    const sev = r.metadata.integrityIssues.map((i) => i.severity);
    expect(sev.indexOf("ERROR")).toBeLessThan(sev.lastIndexOf("WARNING"));
  });
});

describe("cenário 17 — paridade diária × mensal", () => {
  const occurrences = [
    { id: "o1", occurrenceDate: "2026-08-03", status: "concluido" as const },
    { id: "o2", occurrenceDate: "2026-08-13", status: "concluido" as const },
    { id: "o3", occurrenceDate: "2026-08-23", status: "concluido" as const },
  ];
  const input = base({
    monthlyOccurrences: [{ contractId: CONTRATO, monthKey: "2026-08", occurrences }],
    sources: {
      ...base().sources,
      contracts: sourceOk([contrato({ fixedPriceCents: cents(100) })]),
      services: sourceOk([
        ...occurrences.map((o) => svc({
          id: o.id, occurrenceDate: o.occurrenceDate, contractId: CONTRATO, valueCents: cents(0),
        })),
        svc({ id: "avulso", occurrenceDate: "2026-08-07", valueCents: cents(75.5) }),
      ]),
      invoices: sourceOk([fatura({ periodStart: "2026-08-01", grossCents: cents(300) })]),
      cashFlow: sourceOk([caixa({ date: "2026-08-20", amountCents: cents(150) })]),
      payroll: sourceOk([{ id: "p1", periodYear: 2026, periodMonth: 8, netSalaryCents: cents(400), status: "pago" }]),
    },
  });

  const mensal = buildReport(input);
  const diaria = buildDailySeries(input);

  it("a série tem um ponto por dia do mês, incluindo os vazios", () => {
    expect(diaria).toHaveLength(31);
    expect(diaria[0].date).toBe("2026-08-01");
    expect(diaria[0].report.financial.performed.cents).toBe(0);
  });

  it("a soma dos dias fecha no mês para todos os conceitos aditivos", () => {
    expect(checkDailyMonthlyParity(mensal, diaria)).toEqual([]);
  });

  it("a lista de conceitos aditivos é explícita e não inclui saldos nem mensais", () => {
    expect([...ADDITIVE_CONCEPTS]).toEqual([
      "scheduled", "performed", "invoiced", "received", "expenses",
    ]);
    for (const excluido of ["outstanding", "overdue", "contracted", "cost", "payroll"]) {
      expect(ADDITIVE_CONCEPTS as readonly string[]).not.toContain(excluido);
      expect(Object.keys(NON_ADDITIVE_CONCEPTS)).toContain(excluido);
    }
  });

  it("o contratado NÃO é aditivo por dia — 31 dias dariam 31 avenças", () => {
    let soma = 0;
    for (const d of diaria) soma += d.report.financial.contracted.cents ?? 0;
    expect(soma).toBe(cents(100) * 31);
    expect(mensal.financial.contracted.cents).toBe(cents(100));
  });

  it("a folha NÃO é aditiva por dia — payroll_records é por período mensal", () => {
    // Foi este teste que apanhou o defeito: cada janela diária de agosto contém
    // o registo mensal inteiro, e a soma dava 31 × a folha.
    let soma = 0;
    for (const d of diaria) soma += d.report.financial.payroll.cents ?? 0;
    expect(soma).toBe(cents(400) * 31);
    expect(mensal.financial.payroll.cents).toBe(cents(400));
    expect(mensal.financial.cost.cents).toBe(cents(400));
  });

  it("a despesa de caixa, essa, é aditiva — tem data", () => {
    const comDespesa = { ...input, sources: { ...input.sources,
      cashFlow: sourceOk([
        caixa({ id: "d1", date: "2026-08-04", type: "saida", category: "despesa", amountCents: cents(10) }),
        caixa({ id: "d2", date: "2026-08-19", type: "saida", category: "despesa", amountCents: cents(25) }),
      ]),
    } };
    const m = buildReport(comDespesa);
    let soma = 0;
    for (const d of buildDailySeries(comDespesa)) soma += d.report.financial.expenses.cents ?? 0;
    expect(soma).toBe(m.financial.expenses.cents);
    expect(m.financial.expenses.cents).toBe(cents(35));
  });

  it("as métricas operacionais somam entre dias", () => {
    const somadas = sumDailyOperations(diaria);
    expect(somadas.counts.total).toBe(mensal.operations.counts.total);
    expect(somadas.completed).toBe(mensal.operations.completed);
  });

  it("o mês e o dia usam a mesma fórmula — nenhum caminho especial", () => {
    const dia3 = diaria.find((d) => d.date === "2026-08-03")!;
    // 100 € ÷ 3 com o resto na primeira posição da ordem canónica.
    expect(dia3.report.financial.performed.cents).toBe(cents(33.34));
    const dia13 = diaria.find((d) => d.date === "2026-08-13")!;
    expect(dia13.report.financial.performed.cents).toBe(cents(33.33));
  });

  it("collectSeriesIssues não repete o mesmo problema por dia", () => {
    const semMensal = base({
      sources: {
        ...base().sources,
        contracts: sourceOk([contrato()]),
        services: sourceOk(occurrences.map((o) => svc({
          id: o.id, occurrenceDate: o.occurrenceDate, contractId: CONTRATO, valueCents: cents(0),
        }))),
      },
    });
    const issues = collectSeriesIssues(buildDailySeries(semMensal));
    const partial = issues.filter((i) => i.code === "PARTIAL_MONTH_WINDOW");
    expect(partial.length).toBeLessThanOrEqual(2);
  });
});

describe("metadados", () => {
  it("o período e a chave são estáveis", () => {
    const r = buildReport(base());
    expect(r.metadata.periodKey).toBe("2026-08");
    expect(r.metadata.wholeMonth).toBe(true);
    expect(r.metadata.period).toEqual(AGOSTO);
  });

  it("generatedAt e freshestSourceAt vêm de fora — o domínio não lê o relógio", () => {
    const semRelogio = buildReport(base());
    expect(semRelogio.metadata.generatedAt).toBeNull();
    expect(semRelogio.metadata.freshestSourceAt).toBeNull();

    const comRelogio = buildReport(base({
      generatedAt: "2026-08-31T12:00:00Z",
      freshestSourceAt: "2026-08-31T11:59:00Z",
    }));
    expect(comRelogio.metadata.generatedAt).toBe("2026-08-31T12:00:00Z");
    expect(comRelogio.metadata.freshestSourceAt).toBe("2026-08-31T11:59:00Z");
  });

  it("o mesmo input dá sempre exactamente o mesmo output", () => {
    const input = base({
      sources: { ...base().sources, services: sourceOk([svc(), svc({ id: "s2", valueCents: cents(33.33) })]) },
    });
    expect(JSON.stringify(buildReport(input))).toBe(JSON.stringify(buildReport(input)));
  });

  it("todas as fontes aparecem no relatório com o seu estado", () => {
    const r = buildReport(base());
    expect(r.metadata.sources).toHaveLength(8);
  });
});

describe("mês com mudança de hora e fronteiras de calendário", () => {
  it("outubro (fim da hora de verão) tem 31 dias na série", () => {
    const r = buildDailySeries(base({ window: monthPeriod(2026, 10)! }));
    expect(r).toHaveLength(31);
    expect(new Set(r.map((p) => p.date)).size).toBe(31);
  });

  it("fevereiro de ano bissexto tem 29", () => {
    expect(buildDailySeries(base({ window: monthPeriod(2028, 2)! }))).toHaveLength(29);
  });

  it("uma janela que cruza dois meses resolve os dois", () => {
    const r = buildReport(base({
      window: { start: "2026-07-27", end: "2026-08-02" },
      sources: {
        ...base().sources,
        contracts: sourceOk([contrato({ fixedPriceCents: cents(100) })]),
      },
    }));
    // Dois meses tocados → duas mensalidades de contratado, ambas PARTIAL.
    expect(r.financial.contracted.cents).toBe(cents(200));
    expect(r.financial.contracted.completeness).toBe("PARTIAL");
  });
});
