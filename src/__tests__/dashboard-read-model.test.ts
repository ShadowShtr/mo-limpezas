// T15 — Read model do dashboard: KPIs, séries, saúde dos dados.
//
// O defeito central coberto: o cartão "Receita" soma `invoices.total` (COM IVA,
// INCLUINDO rascunhos) e a "Margem Bruta" subtrai-lhe apenas a folha. O imposto
// entra como se fosse receita da empresa e as despesas de caixa não entram de
// todo nos custos.

import { describe, it, expect } from "vitest";
import {
  type DashboardInput,
  buildDashboardView,
  contractedVsPerformed,
  invoicedVsReceived,
  LEGACY_KPI_NAMING,
  misnamedKpis,
  trustworthyKpis,
  unavailableKpis,
} from "@/domain/dashboard/dashboard-read-model";
import { buildDashboardPeriods } from "@/domain/dashboard/period-selection";
import { buildClientSummaries } from "@/domain/dashboard/client-summary";
import {
  buildDailySeries,
  buildReport,
  type ReportInput,
} from "@/domain/reports/report-read-model";
import { sourceFailed, sourceOk } from "@/domain/reports/integrity";
import { monthPeriod } from "@/domain/reports/period";
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

const cents = (v: number) => eurosToCents(v)!;
const PERIODS = buildDashboardPeriods("2026-08-13")!;

function reportFor(
  month: { y: number; m: number },
  over: Partial<ReportInput["sources"]> = {},
  extra: Partial<ReportInput> = {},
) {
  const window = monthPeriod(month.y, month.m)!;
  return buildReport({
    window,
    asOf: window.end,
    marginBasis: "invoiced",
    sources: {
      services: sourceOk<ServiceInput>([]),
      contracts: sourceOk<ContractInput>([]),
      invoices: sourceOk<InvoiceInput>([]),
      cashFlow: sourceOk<CashFlowInput>([]),
      payroll: sourceOk<PayrollInput>([]),
      timesheets: sourceOk<TimesheetInput>([]),
      absences: sourceOk<AbsenceInput>([]),
      vat: sourceOk([{ ratePct: 23 }]),
      ...over,
    },
    ...extra,
  });
}

function inv(over: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    id: "i1", periodStart: "2026-08-01", dueDate: "2026-08-31",
    netCents: cents(100), vatCents: cents(23), grossCents: cents(123),
    vatRatePct: 23, status: "pendente", itemCount: 1, ...over,
  };
}

function cash(over: Partial<CashFlowInput> = {}): CashFlowInput {
  return {
    id: "cf1", date: "2026-08-10", type: "entrada",
    amountCents: cents(100), category: "faturacao", status: "confirmado", ...over,
  };
}

function base(over: Partial<DashboardInput> = {}): DashboardInput {
  return { periods: PERIODS, current: reportFor({ y: 2026, m: 8 }), ...over };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("cenário 1 — mês vazio", () => {
  const v = buildDashboardView(base());

  it("todos os KPIs existem e são zeros legítimos", () => {
    expect(v.kpis.invoiced.amount.cents).toBe(0);
    expect(v.kpis.invoiced.availability).toBe("AVAILABLE");
  });

  it("a saúde dos dados é fiável", () => {
    expect(v.health.completeness).toBe("COMPLETE");
    expect(v.health.trustworthy).toBe(true);
    expect(v.health.criticalCount).toBe(0);
  });

  it("sem período anterior, a comparação é UNAVAILABLE e não zero", () => {
    expect(v.kpis.invoiced.comparison.percent.kind).toBe("UNAVAILABLE");
    expect(v.kpis.invoiced.comparison.absoluteDeltaCents).toBeNull();
  });
});

describe("nomes: o que o ecrã chama e o que o número é", () => {
  const v = buildDashboardView(base());

  it("o conceito canónico do cartão 'Receita' é Faturado", () => {
    expect(v.kpis.invoiced.label).toBe("Faturado");
    expect(v.kpis.invoiced.legacyLabel).toBe("Receita");
  });

  it("a divergência de cada nome está documentada", () => {
    expect(v.kpis.invoiced.divergenceNote).toContain("COM IVA");
    expect(v.kpis.invoiced.divergenceNote).toContain("rascunho");
    expect(v.kpis.cost.divergenceNote).toContain("cash_flow_entries");
    expect(v.kpis.margin.divergenceNote).toContain("imposto");
    expect(v.kpis.overdue.divergenceNote).toContain("12 meses");
  });

  it("misnamedKpis lista exactamente os quatro cartões mal nomeados", () => {
    expect(misnamedKpis(v).map((k) => k.key).sort())
      .toEqual(["cost", "invoiced", "margin", "overdue"]);
  });

  it("o inventário de nomes legados cobre esses quatro e mais nenhum", () => {
    expect(Object.keys(LEGACY_KPI_NAMING).sort())
      .toEqual(["cost", "invoiced", "margin", "overdue"]);
  });

  it("nenhum KPI se chama apenas 'Receita'", () => {
    for (const kpi of Object.values(v.kpis)) {
      expect(kpi.label).not.toBe("Receita");
    }
  });
});

describe("cenários 5 a 8 — faturado, recebido, em aberto", () => {
  it("faturado exclui rascunhos, ao contrário do dashboard actual", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        invoices: sourceOk([
          inv({ id: "i1", grossCents: cents(123) }),
          inv({ id: "i2", status: "rascunho", grossCents: cents(5000) }),
        ]),
      }),
    }));
    expect(v.kpis.invoiced.amount.cents).toBe(cents(123));
  });

  it("faturado sem recebido deixa tudo em aberto", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, { invoices: sourceOk([inv()]) }),
    }));
    const r = invoicedVsReceived(v);
    expect(r.outstanding.cents).toBe(cents(123));
    expect(r.receivedExceedsInvoiced).toBe(false);
  });

  it("recebido acima do faturado não é achatado em zero", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        invoices: sourceOk([inv({ grossCents: cents(100) })]),
        cashFlow: sourceOk([cash({ amountCents: cents(300) })]),
      }),
    }));
    const r = invoicedVsReceived(v);
    expect(r.outstanding.cents).toBe(cents(-200));
    expect(r.receivedExceedsInvoiced).toBe(true);
    expect(v.health.byCode.RECEIVED_GT_INVOICED).toBe(1);
  });
});

describe("cenários 9 e 10 — custos sem dupla contagem", () => {
  const v = buildDashboardView(base({
    current: reportFor({ y: 2026, m: 8 }, {
      payroll: sourceOk([{
        id: "p1", periodYear: 2026, periodMonth: 8,
        netSalaryCents: cents(1000), status: "pago",
      }]),
      cashFlow: sourceOk([
        cash({ id: "d1", type: "saida", category: "despesa", amountCents: cents(200) }),
        // Espelho da folha em caixa: não pode entrar outra vez.
        cash({ id: "d2", type: "saida", category: "salario", amountCents: cents(1000) }),
      ]),
    }),
  }));

  it("folha e despesas somam uma só vez", () => {
    expect(v.kpis.payroll.amount.cents).toBe(cents(1000));
    expect(v.kpis.expenses.amount.cents).toBe(cents(200));
    expect(v.kpis.cost.amount.cents).toBe(cents(1200));
  });

  it("os custos canónicos incluem as despesas, que o dashboard actual ignora", () => {
    // O cartão "Custos (Salários)" mostraria 1000 €.
    expect(v.kpis.cost.amount.cents).toBeGreaterThan(cents(1000));
  });
});

describe("margem", () => {
  it("declara a base usada em vez de a esconder", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        invoices: sourceOk([inv({ grossCents: cents(1000) })]),
        payroll: sourceOk([{
          id: "p1", periodYear: 2026, periodMonth: 8,
          netSalaryCents: cents(400), status: "pago",
        }]),
      }),
    }));
    expect(v.marginBasis).toBe("invoiced");
    expect(v.kpis.margin.amount.cents).toBe(cents(600));
  });

  it("margem negativa mantém-se negativa", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        payroll: sourceOk([{
          id: "p1", periodYear: 2026, periodMonth: 8,
          netSalaryCents: cents(3000), status: "pago",
        }]),
      }),
    }));
    expect(v.kpis.margin.amount.cents).toBe(cents(-3000));
  });
});

describe("cenários 14 a 16 — fonte que falha", () => {
  it("caixa falhada torna 'recebido' UNAVAILABLE, não zero", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, { cashFlow: sourceFailed<CashFlowInput>("timeout") }),
    }));
    expect(v.kpis.received.availability).toBe("UNAVAILABLE");
    expect(v.kpis.received.amount.cents).toBeNull();
  });

  it("um KPI indisponível não degrada os outros", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        cashFlow: sourceFailed<CashFlowInput>(),
        invoices: sourceOk([inv()]),
      }),
    }));
    expect(v.kpis.received.availability).toBe("UNAVAILABLE");
    expect(v.kpis.invoiced.availability).toBe("AVAILABLE");
    expect(trustworthyKpis(v).map((k) => k.key)).toContain("invoiced");
    expect(unavailableKpis(v).map((k) => k.key)).toContain("received");
  });

  it("folha falhada torna margem e custos indisponíveis", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        payroll: sourceFailed<PayrollInput>(),
        cashFlow: sourceFailed<CashFlowInput>(),
      }),
    }));
    expect(v.kpis.cost.availability).toBe("UNAVAILABLE");
    expect(v.kpis.margin.availability).toBe("UNAVAILABLE");
  });

  it("a saúde dos dados regista a fonte em falta e deixa de ser fiável", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, { invoices: sourceFailed<InvoiceInput>() }),
    }));
    expect(v.health.completeness).toBe("PARTIAL");
    expect(v.health.trustworthy).toBe(false);
    expect(v.health.sourcesUnavailable).toContain("invoices");
    expect(v.health.criticalCount).toBeGreaterThan(0);
  });

  it("a saúde agregada assume o estado mais fraco dos períodos", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }),
      monthly: [
        reportFor({ y: 2026, m: 7 }),
        reportFor({ y: 2026, m: 8 }, { payroll: sourceFailed<PayrollInput>() }),
      ],
    }));
    expect(v.health.completeness).toBe("PARTIAL");
    expect(v.health.sourcesUnavailable).toContain("payroll_records");
  });
});

describe("cenário 17 e 18 — comparação com o mês anterior", () => {
  const anterior = reportFor({ y: 2026, m: 7 }, {
    invoices: sourceOk([inv({ periodStart: "2026-07-01", grossCents: cents(1000) })]),
  });

  it("compara quando há os dois lados", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        invoices: sourceOk([inv({ grossCents: cents(1500) })]),
      }),
      previous: anterior,
    }));
    expect(v.kpis.invoiced.comparison.absoluteDeltaCents).toBe(cents(500));
    expect(v.kpis.invoiced.comparison.percent).toEqual({ kind: "VALUE", percent: 50 });
    expect(v.comparisonPeriod).toEqual(anterior.metadata.period);
  });

  it("mês anterior a zero dá NOT_COMPARABLE, nunca +Infinity%", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        invoices: sourceOk([inv({ grossCents: cents(1500) })]),
      }),
      previous: reportFor({ y: 2026, m: 7 }),
    }));
    expect(v.kpis.invoiced.comparison.percent.kind).toBe("NOT_COMPARABLE");
  });

  it("mês corrente a zero sobre anterior com valor dá −100%", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }),
      previous: anterior,
    }));
    expect(v.kpis.invoiced.comparison.percent).toEqual({ kind: "VALUE", percent: -100 });
    expect(v.kpis.invoiced.comparison.trend).toBe("down");
  });

  it("os conceitos de saldo são marcados como snapshot", () => {
    const v = buildDashboardView(base({ previous: anterior }));
    expect(v.kpis.outstanding.comparison.snapshot).toBe(true);
    expect(v.kpis.overdue.comparison.snapshot).toBe(true);
    expect(v.kpis.payroll.comparison.snapshot).toBe(true);
    expect(v.kpis.contracted.comparison.snapshot).toBe(true);
    // Fluxos não são snapshot.
    expect(v.kpis.invoiced.comparison.snapshot).toBe(false);
    expect(v.kpis.performed.comparison.snapshot).toBe(false);
  });
});

describe("série diária", () => {
  const window = monthPeriod(2026, 8)!;
  const reportInput: ReportInput = {
    window,
    asOf: window.end,
    marginBasis: "invoiced",
    sources: {
      services: sourceOk<ServiceInput>([{
        id: "s1", occurrenceDate: "2026-08-05", status: "concluido", contractId: null,
        valueCents: cents(80), applyVat: false, workedMinutes: null, scheduledMinutes: 60,
      }]),
      contracts: sourceOk([]),
      invoices: sourceOk([inv()]),
      cashFlow: sourceOk([cash()]),
      payroll: sourceOk([]),
      timesheets: sourceOk([]),
      absences: sourceOk([]),
      vat: sourceOk([{ ratePct: 23 }]),
    },
  };

  const v = buildDashboardView(base({
    current: buildReport(reportInput),
    daily: buildDailySeries(reportInput),
  }));

  it("tem um ponto por dia do mês, incluindo os vazios", () => {
    expect(v.series.daily).toHaveLength(31);
    expect(v.series.daily[0].date).toBe("2026-08-01");
  });

  it("um dia sem serviços aparece com zeros em vez de desaparecer", () => {
    const dia1 = v.series.daily[0];
    expect(dia1.services).toBe(0);
    expect(dia1.performed.cents).toBe(0);
  });

  it("a soma do realizado diário bate com o KPI do mês", () => {
    const soma = v.series.daily.reduce((a, p) => a + (p.performed.cents ?? 0), 0);
    expect(soma).toBe(v.kpis.performed.amount.cents);
  });

  it("a margem diária é null — a folha é mensal e contaminaria o dia", () => {
    for (const p of v.series.daily) expect(p.margin).toBeNull();
  });
});

describe("série mensal", () => {
  const v = buildDashboardView(base({
    monthly: [
      reportFor({ y: 2026, m: 7 }, {
        invoices: sourceOk([inv({ periodStart: "2026-07-01", grossCents: cents(1000) })]),
      }),
      reportFor({ y: 2026, m: 8 }, {
        payroll: sourceOk([{
          id: "p1", periodYear: 2026, periodMonth: 8,
          netSalaryCents: cents(300), status: "pago",
        }]),
      }),
    ],
  }));

  it("tem uma chave estável por mês", () => {
    expect(v.series.monthly.map((m) => m.monthKey)).toEqual(["2026-07", "2026-08"]);
  });

  it("a percentagem de margem é tipada, não um 0 mascarado", () => {
    // Agosto: faturado 0, margem −300. O dashboard actual mostraria "0%".
    const agosto = v.series.monthly.find((m) => m.monthKey === "2026-08")!;
    expect(agosto.margin.cents).toBe(cents(-300));
    expect(agosto.marginPercent.kind).toBe("NOT_COMPARABLE");
    expect(agosto.marginPercent.percent).toBeNull();
  });

  it("com receita real, a percentagem tem valor", () => {
    const julho = v.series.monthly.find((m) => m.monthKey === "2026-07")!;
    expect(julho.marginPercent.kind).toBe("VALUE");
    expect(julho.marginPercent.percent).toBe(100);
  });
});

describe("contratado × realizado", () => {
  it("dá o delta sem inferir perda", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        contracts: sourceOk([{
          id: "c1", fixedMonthly: true, fixedPriceCents: cents(300), applyVat: false,
          startsOn: null, endsOn: null, status: "ativo",
        }]),
      }),
    }));
    const r = contractedVsPerformed(v);
    expect(r.contracted.cents).toBe(cents(300));
    expect(r.performed.cents).toBe(0);
    expect(r.deltaCents).toBe(cents(-300));
    expect(r.comparable).toBe(true);
  });

  it("não é comparável quando uma das fontes falhou", () => {
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, { contracts: sourceFailed<ContractInput>() }),
    }));
    expect(contractedVsPerformed(v).comparable).toBe(false);
    expect(contractedVsPerformed(v).deltaCents).toBeNull();
  });
});

describe("projeção dentro da vista", () => {
  it("usa apenas os meses do ano corrente", () => {
    const v = buildDashboardView(base({
      periods: buildDashboardPeriods("2026-03-15")!,
      current: reportFor({ y: 2026, m: 3 }),
      monthly: [
        // Dezembro do ano ANTERIOR não pode entrar na projeção do ano.
        reportFor({ y: 2025, m: 12 }, {
          invoices: sourceOk([inv({ periodStart: "2025-12-01", grossCents: cents(9999) })]),
        }),
        reportFor({ y: 2026, m: 1 }, {
          invoices: sourceOk([inv({ periodStart: "2026-01-01", grossCents: cents(1000) })]),
        }),
        reportFor({ y: 2026, m: 2 }, {
          invoices: sourceOk([inv({ periodStart: "2026-02-01", grossCents: cents(1000) })]),
        }),
        reportFor({ y: 2026, m: 3 }, {
          invoices: sourceOk([inv({ periodStart: "2026-03-01", grossCents: cents(200) })]),
        }),
      ],
    }));
    expect(v.projection).not.toBeNull();
    expect(v.projection!.observedCents).toBe(cents(2200));
    // Fórmula legada: 2200 ÷ 2 = 1100 → 2200 + 1100 × 9 = 12 100.
    expect(v.projection!.projectedCents).toBe(cents(12_100));
  });

  it("sem série mensal não há projeção — e isso é null, não zero", () => {
    expect(buildDashboardView(base()).projection).toBeNull();
  });
});

describe("operacional", () => {
  it("conta serviços por estado e compara com o mês anterior", () => {
    const svc = (id: string, status: string): ServiceInput => ({
      id, occurrenceDate: "2026-08-05", status, contractId: null,
      valueCents: cents(10), applyVat: false, workedMinutes: null, scheduledMinutes: 60,
    });
    const v = buildDashboardView(base({
      current: reportFor({ y: 2026, m: 8 }, {
        services: sourceOk([
          svc("1", "concluido"), svc("2", "cancelado"), svc("3", "falta"), svc("4", "sem_cobertura"),
        ]),
      }),
      previous: reportFor({ y: 2026, m: 7 }),
    }));
    expect(v.operational.completedServices).toBe(1);
    expect(v.operational.cancelledServices).toBe(1);
    expect(v.operational.absences).toBe(1);
    expect(v.operational.scheduledServices).toBe(3);
    expect(v.operational.comparison.completedServices.percent.kind).toBe("NOT_COMPARABLE");
  });
});

describe("clientes", () => {
  it("ordena pela grandeza declarada e não por 'receita' genérica", () => {
    const v = buildDashboardView(base({
      clients: buildClientSummaries([
        { clientId: "c1", invoicedCents: cents(100), receivedCents: cents(100) },
        { clientId: "c2", invoicedCents: cents(500), receivedCents: cents(0) },
      ]),
      topClientsBasis: "received",
    }));
    expect(v.topClientsBasis).toBe("received");
    expect(v.topClients[0].clientId).toBe("c1");
  });

  it("o DTO de cliente não leva nome nenhum consigo", () => {
    const v = buildDashboardView(base({
      clients: buildClientSummaries([{ clientId: "c1", invoicedCents: cents(100) }]),
    }));
    expect(Object.keys(v.topClients[0])).not.toContain("clientName");
    expect(Object.keys(v.topClients[0])).not.toContain("name");
  });
});

describe("determinismo e frescura", () => {
  it("o mesmo input dá sempre o mesmo output", () => {
    const i = base({ current: reportFor({ y: 2026, m: 8 }, { invoices: sourceOk([inv()]) }) });
    expect(JSON.stringify(buildDashboardView(i))).toBe(JSON.stringify(buildDashboardView(i)));
  });

  it("a frescura vem de fora e desconhecida é null, não uma data inventada", () => {
    const v = buildDashboardView(base());
    expect(v.health.freshestSourceAt).toBeNull();
    expect(v.health.generatedAt).toBeNull();

    const comRelogio = buildDashboardView(base({
      generatedAt: "2026-08-13T10:00:00Z",
      freshestSourceAt: "2026-08-13T09:55:00Z",
    }));
    expect(comRelogio.health.generatedAt).toBe("2026-08-13T10:00:00Z");
    expect(comRelogio.health.freshestSourceAt).toBe("2026-08-13T09:55:00Z");
  });
});
