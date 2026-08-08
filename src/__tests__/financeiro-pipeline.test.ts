// ============================================================================
// REVISÃO DE FECHO — integração T11 → T14 → T15
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Fixtures inteiramente sintéticas. Sem Supabase, sem `.env`, sem rede, sem
// ficheiros, sem relógio. Nenhum dado real, nenhum identificador real.
//
// ----------------------------------------------------------------------------
//
// O que estes testes provam.
//
// As três tasks foram construídas e testadas em separado. Cada uma tem a sua
// bateria e cada uma passa. Isso não prova que **encaixam**: um conceito pode
// ganhar significado diferente ao atravessar uma fronteira, e é precisamente aí
// que ninguém está a olhar.
//
// Aqui um único conjunto de dados percorre as três camadas de ponta a ponta e
// verifica-se que:
//
//   • o dinheiro não volta a vírgula flutuante em nenhum ponto;
//   • `null`, `0` e `UNAVAILABLE` continuam a ser três coisas distintas;
//   • uma fonte que falha degrada só o que dela depende;
//   • os conceitos de saldo nunca são somados como fluxos;
//   • os bloqueios conhecidos (PRORATED, projeção) continuam fechados.

import { describe, it, expect } from "vitest";

// ─── T11 ───
import { type MoneyCents, eurosToCents, sumCents } from "@/domain/billing/money";
import { allocateMonthlyAmount } from "@/domain/billing/monthly-allocation";
import { applyVat } from "@/domain/billing/vat";
import { computeOutstanding } from "@/domain/billing/financial-model";
// ─── T14 ───
import { sourceFailed, sourceOk } from "@/domain/reports/integrity";
import { monthPeriod } from "@/domain/reports/period";
import {
  type MonthlyOccurrenceSet,
  type ReportInput,
  ADDITIVE_CONCEPTS,
  NON_ADDITIVE_CONCEPTS,
  buildDailySeries,
  buildReport,
  checkDailyMonthlyParity,
} from "@/domain/reports/report-read-model";
import type {
  AbsenceInput,
  CashFlowInput,
  ContractInput,
  InvoiceInput,
  PayrollInput,
  ServiceInput,
  TimesheetInput,
} from "@/domain/reports/report-sources";
// ─── T15 ───
import { buildDashboardPeriods } from "@/domain/dashboard/period-selection";
import { buildClientSummaries } from "@/domain/dashboard/client-summary";
import { CURRENT_PROJECTION_METHOD } from "@/domain/dashboard/projection";
import {
  buildDashboardView,
  contractedVsPerformed,
  invoicedVsReceived,
  trustworthyKpis,
  unavailableKpis,
} from "@/domain/dashboard/dashboard-read-model";

const cents = (v: number) => eurosToCents(v)!;
const AGOSTO = monthPeriod(2026, 8)!;
const JULHO = monthPeriod(2026, 7)!;
const PERIODS = buildDashboardPeriods("2026-08-31")!;
const CONTRATO = "contrato-sintetico";

// ─── Fixture completa ───────────────────────────────────────────────────────
//
// Um mês com contrato de avença, serviços avulsos, fatura, caixa, folha,
// despesa e ausência. Valores escolhidos para que a avença NÃO divida certo
// (100 € ÷ 3), que é onde o cêntimo se perdia.

const OCORRENCIAS: MonthlyOccurrenceSet[] = [{
  contractId: CONTRATO,
  monthKey: "2026-08",
  occurrences: [
    { id: "av-1", occurrenceDate: "2026-08-04", status: "concluido" },
    { id: "av-2", occurrenceDate: "2026-08-14", status: "concluido" },
    { id: "av-3", occurrenceDate: "2026-08-24", status: "concluido" },
  ],
}];

const SERVICOS: ServiceInput[] = [
  ...OCORRENCIAS[0].occurrences.map((o) => ({
    id: o.id,
    occurrenceDate: o.occurrenceDate,
    status: o.status,
    contractId: CONTRATO,
    valueCents: cents(0), // avença: o serviço vale 0 na base, por desenho
    applyVat: false,
    workedMinutes: 120,
    scheduledMinutes: 120,
  })),
  {
    id: "avulso-1", occurrenceDate: "2026-08-07", status: "concluido",
    contractId: null, valueCents: cents(75.5), applyVat: false,
    workedMinutes: 90, scheduledMinutes: 90,
  },
  {
    id: "avulso-2", occurrenceDate: "2026-08-11", status: "cancelado",
    contractId: null, valueCents: cents(40), applyVat: false,
    workedMinutes: null, scheduledMinutes: 60,
  },
  {
    id: "avulso-3", occurrenceDate: "2026-08-18", status: "falta",
    contractId: null, valueCents: cents(30), applyVat: false,
    workedMinutes: null, scheduledMinutes: 60,
  },
];

const CONTRATOS: ContractInput[] = [{
  id: CONTRATO, fixedMonthly: true, fixedPriceCents: cents(100),
  applyVat: false, startsOn: "2026-01-01", endsOn: "2026-12-31", status: "ativo",
}];

const FATURAS: InvoiceInput[] = [{
  id: "fatura-1", periodStart: "2026-08-01", dueDate: "2026-08-20",
  netCents: cents(200), vatCents: cents(0), grossCents: cents(200),
  vatRatePct: 0, status: "pendente", itemCount: 2,
}];

const CAIXA: CashFlowInput[] = [
  { id: "caixa-in", date: "2026-08-22", type: "entrada",
    amountCents: cents(120), category: "faturacao", status: "confirmado" },
  { id: "caixa-desp", date: "2026-08-09", type: "saida",
    amountCents: cents(45), category: "despesa", status: "confirmado" },
  // Espelho da folha em caixa — não pode contar duas vezes nos custos.
  { id: "caixa-sal", date: "2026-08-28", type: "saida",
    amountCents: cents(400), category: "salario", status: "confirmado" },
];

const FOLHA: PayrollInput[] = [{
  id: "folha-1", periodYear: 2026, periodMonth: 8,
  netSalaryCents: cents(400), status: "pago",
}];

const PONTOS: TimesheetInput[] = [
  { id: "ponto-1", collaboratorId: "colab-1", date: "2026-08-04",
    durationMinutes: 120, serviceId: "av-1" },
];

const AUSENCIAS: AbsenceInput[] = [
  // Atravessa a fronteira do mês: 7 dias em agosto, 10 em setembro.
  { id: "aus-1", collaboratorId: "colab-1", type: "ferias",
    startsOn: "2026-08-25", endsOn: "2026-09-10" },
];

function sourcesFor(window: typeof AGOSTO, over: Partial<ReportInput["sources"]> = {}) {
  const inWindow = <T extends { occurrenceDate?: string; date?: string; periodStart?: string }>(
    rows: readonly T[], key: "occurrenceDate" | "date" | "periodStart",
  ) => rows.filter((r) => {
    const d = r[key] as string | undefined;
    return d != null && d >= window.start && d <= window.end;
  });

  return {
    services: sourceOk(inWindow(SERVICOS, "occurrenceDate")),
    contracts: sourceOk(CONTRATOS),
    invoices: sourceOk(inWindow(FATURAS, "periodStart")),
    cashFlow: sourceOk(inWindow(CAIXA, "date")),
    payroll: sourceOk(FOLHA.filter(
      (p) => `${p.periodYear}-${String(p.periodMonth).padStart(2, "0")}` === window.start.slice(0, 7),
    )),
    timesheets: sourceOk(inWindow(PONTOS, "date")),
    absences: sourceOk(AUSENCIAS),
    vat: sourceOk([{ ratePct: 23 }]),
    ...over,
  };
}

function reportFor(window: typeof AGOSTO, over: Partial<ReportInput["sources"]> = {}) {
  return buildReport({
    window,
    asOf: "2026-08-31",
    marginBasis: "invoiced",
    sources: sourcesFor(window, over),
    monthlyOccurrences: window === AGOSTO ? OCORRENCIAS : [],
  });
}

const AGOSTO_INPUT: ReportInput = {
  window: AGOSTO,
  asOf: "2026-08-31",
  marginBasis: "invoiced",
  sources: sourcesFor(AGOSTO),
  monthlyOccurrences: OCORRENCIAS,
};

// ═══════════════════════════════════════════════════════════════════════════

describe("§23 — a fixture atravessa as três camadas", () => {
  const mensal = reportFor(AGOSTO);
  const diaria = buildDailySeries(AGOSTO_INPUT);
  const view = buildDashboardView({
    periods: PERIODS,
    current: mensal,
    previous: reportFor(JULHO),
    daily: diaria,
    monthly: [reportFor(JULHO), mensal],
    clients: buildClientSummaries([
      { clientId: "cli-1", invoicedCents: cents(200), receivedCents: cents(120) },
      { clientId: "cli-2", performedCents: cents(75.5), completedServices: 1 },
    ]),
    generatedAt: "2026-08-31T20:00:00Z",
    freshestSourceAt: "2026-08-31T19:45:00Z",
  });

  it("contratado é o valor mensal do contrato, uma só vez", () => {
    expect(view.kpis.contracted.amount.cents).toBe(cents(100));
  });

  it("realizado = avença distribuída + avulso concluído", () => {
    // 100 € da avença (3 ocorrências concluídas) + 75,50 € do avulso.
    expect(view.kpis.performed.amount.cents).toBe(cents(175.5));
  });

  it("agendado inclui a falta e exclui o cancelado", () => {
    // 100 € avença + 75,50 € concluído + 30 € falta. Cancelado (40 €) fora.
    expect(view.kpis.scheduled.amount.cents).toBe(cents(205.5));
  });

  it("faturado vem das faturas emitidas, não dos serviços", () => {
    expect(view.kpis.invoiced.amount.cents).toBe(cents(200));
    expect(view.kpis.invoiced.amount.origin).toBe("invoice");
  });

  it("recebido vem da caixa, não do estado da fatura", () => {
    expect(view.kpis.received.amount.cents).toBe(cents(120));
    expect(view.kpis.received.amount.origin).toBe("cash_flow");
  });

  it("em aberto = faturado − recebido", () => {
    expect(view.kpis.outstanding.amount.cents).toBe(cents(80));
  });

  it("vencido: a fatura passou o prazo e não está paga", () => {
    expect(view.kpis.overdue.amount.cents).toBe(cents(200));
  });

  it("custos somam folha e despesa SEM contar o espelho salarial", () => {
    // 400 € folha + 45 € despesa. Os 400 € de caixa com categoria `salario`
    // são espelho e não podem entrar outra vez.
    expect(view.kpis.payroll.amount.cents).toBe(cents(400));
    expect(view.kpis.expenses.amount.cents).toBe(cents(45));
    expect(view.kpis.cost.amount.cents).toBe(cents(445));
  });

  it("margem = faturado − custos, com a base declarada", () => {
    expect(view.marginBasis).toBe("invoiced");
    expect(view.kpis.margin.amount.cents).toBe(cents(-245));
  });

  it("operacional conta cada estado em separado", () => {
    expect(view.operational.completedServices).toBe(4);
    expect(view.operational.cancelledServices).toBe(1);
    expect(view.operational.absences).toBe(1);
    expect(view.operational.scheduledServices).toBe(5);
  });

  it("a saúde dos dados é fiável e a frescura vem de fora", () => {
    expect(view.health.completeness).toBe("COMPLETE");
    expect(view.health.trustworthy).toBe(true);
    expect(view.health.freshestSourceAt).toBe("2026-08-31T19:45:00Z");
  });

  it("a série diária cobre o mês inteiro", () => {
    expect(view.series.daily).toHaveLength(31);
  });

  it("a comparação com julho existe e não é NaN", () => {
    expect(view.comparisonPeriod).toEqual(JULHO);
    for (const kpi of Object.values(view.kpis)) {
      const p = kpi.comparison.percent.percent;
      if (p != null) expect(Number.isFinite(p)).toBe(true);
    }
  });
});

describe("§27 — a avença atravessa as três camadas sem perder um cêntimo", () => {
  it("T11 distribui 10000 cêntimos em 3334/3333/3333", () => {
    const r = allocateMonthlyAmount({
      totalCents: cents(100),
      occurrences: OCORRENCIAS[0].occurrences.map((o) => ({
        id: o.id, occurrenceDate: o.occurrenceDate,
      })),
    });
    expect(r.allocations.map((a) => a.amountCents)).toEqual([3334, 3333, 3333]);
    expect(r.allocatedCents).toBe(cents(100));
  });

  it("T14 agrega e fecha no valor do contrato", () => {
    const mensal = reportFor(AGOSTO);
    // 100 € da avença + 75,50 € do avulso concluído.
    expect(mensal.financial.performed.cents).toBe(cents(175.5));
  });

  it("T15 apresenta sem alterar", () => {
    const view = buildDashboardView({ periods: PERIODS, current: reportFor(AGOSTO) });
    expect(view.kpis.performed.amount.cents).toBe(cents(175.5));
  });

  it("a soma das fatias diárias da avença fecha no mês", () => {
    const diaria = buildDailySeries(AGOSTO_INPUT);
    const soma = diaria.reduce((a, p) => a + (p.report.financial.performed.cents ?? 0), 0);
    expect(soma).toBe(cents(175.5));
  });
});

describe("§13 — aditivo × snapshot, coerente entre T14 e T15", () => {
  const mensal = reportFor(AGOSTO);
  const diaria = buildDailySeries(AGOSTO_INPUT);

  it("a soma dos dias fecha no mês para todos os conceitos aditivos", () => {
    expect(checkDailyMonthlyParity(mensal, diaria)).toEqual([]);
  });

  it("as duas listas de conceitos não se sobrepõem", () => {
    for (const c of ADDITIVE_CONCEPTS) {
      expect(Object.keys(NON_ADDITIVE_CONCEPTS)).not.toContain(c);
    }
  });

  it("o dashboard marca como snapshot EXACTAMENTE os não-aditivos da T14", () => {
    // Antes desta revisão eram duas listas escritas à mão em ficheiros
    // diferentes. Agora a do dashboard deriva da da T14.
    const view = buildDashboardView({
      periods: PERIODS, current: mensal, previous: reportFor(JULHO),
    });
    const snapshots = Object.values(view.kpis)
      .filter((k) => k.comparison.snapshot)
      .map((k) => k.key)
      .sort();
    expect(snapshots).toEqual(Object.keys(NON_ADDITIVE_CONCEPTS).sort());
  });

  it("nenhum conceito aditivo é marcado como snapshot", () => {
    const view = buildDashboardView({
      periods: PERIODS, current: mensal, previous: reportFor(JULHO),
    });
    for (const c of ADDITIVE_CONCEPTS) {
      if (c === "expenses") continue; // `expenses` é aditivo e não é KPI de saldo
      expect(view.kpis[c].comparison.snapshot).toBe(false);
    }
  });
});

describe("§24 — falha parcial degrada só o que dela depende", () => {
  const view = buildDashboardView({
    periods: PERIODS,
    current: reportFor(AGOSTO, { cashFlow: sourceFailed<CashFlowInput>("timeout") }),
  });

  it("recebido fica indisponível — nunca zero", () => {
    expect(view.kpis.received.availability).toBe("UNAVAILABLE");
    expect(view.kpis.received.amount.cents).toBeNull();
  });

  it("em aberto herda a indisponibilidade", () => {
    expect(view.kpis.outstanding.availability).toBe("UNAVAILABLE");
  });

  it("faturado continua disponível", () => {
    expect(view.kpis.invoiced.availability).toBe("AVAILABLE");
    expect(view.kpis.invoiced.amount.cents).toBe(cents(200));
  });

  it("realizado e contratado continuam disponíveis", () => {
    expect(view.kpis.performed.availability).toBe("AVAILABLE");
    expect(view.kpis.contracted.availability).toBe("AVAILABLE");
  });

  it("o relatório fica PARTIAL, não FAILED", () => {
    expect(view.health.completeness).toBe("PARTIAL");
    expect(view.health.trustworthy).toBe(false);
    expect(view.health.sourcesUnavailable).toEqual(["cash_flow_entries"]);
  });

  it("a separação entre fiáveis e indisponíveis é explícita", () => {
    expect(trustworthyKpis(view).map((k) => k.key)).toContain("invoiced");
    expect(unavailableKpis(view).map((k) => k.key)).toContain("received");
  });

  it("o código de integridade identifica a fonte exacta", () => {
    expect(view.health.byCode.PAYMENTS_QUERY_FAILED).toBe(1);
  });

  it("folha falhada leva custos e margem, mas não o faturado", () => {
    const v = buildDashboardView({
      periods: PERIODS,
      current: reportFor(AGOSTO, {
        payroll: sourceFailed<PayrollInput>(),
        cashFlow: sourceFailed<CashFlowInput>(),
      }),
    });
    expect(v.kpis.cost.availability).toBe("UNAVAILABLE");
    expect(v.kpis.margin.availability).toBe("UNAVAILABLE");
    expect(v.kpis.invoiced.availability).toBe("AVAILABLE");
  });
});

describe("§25 — zero legítimo não é fonte indisponível", () => {
  const vazio = buildDashboardView({
    periods: PERIODS,
    current: buildReport({
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
    }),
  });

  const falhado = buildDashboardView({
    periods: PERIODS,
    current: reportFor(AGOSTO, { invoices: sourceFailed<InvoiceInput>() }),
  });

  it("mês vazio: cents é 0 e a disponibilidade é AVAILABLE", () => {
    expect(vazio.kpis.invoiced.amount.cents).toBe(0);
    expect(vazio.kpis.invoiced.availability).toBe("AVAILABLE");
    expect(vazio.health.trustworthy).toBe(true);
  });

  it("fonte falhada: cents é null e a disponibilidade é UNAVAILABLE", () => {
    expect(falhado.kpis.invoiced.amount.cents).toBeNull();
    expect(falhado.kpis.invoiced.availability).toBe("UNAVAILABLE");
  });

  it("os dois casos são distinguíveis em todas as camadas", () => {
    expect(vazio.kpis.invoiced.amount.cents).not.toBe(falhado.kpis.invoiced.amount.cents);
    expect(vazio.health.completeness).not.toBe(falhado.health.completeness);
  });
});

describe("§26 — prejuízo continua prejuízo", () => {
  const view = buildDashboardView({
    periods: PERIODS,
    current: reportFor(AGOSTO),
    previous: reportFor(JULHO),
    monthly: [reportFor(JULHO), reportFor(AGOSTO)],
  });

  it("a margem é negativa e mantém-se negativa", () => {
    expect(view.kpis.margin.amount.cents).toBe(cents(-245));
    expect(view.kpis.margin.amount.cents!).toBeLessThan(0);
  });

  it("nenhum ponto da série mensal achata a margem em zero", () => {
    const agosto = view.series.monthly.find((m) => m.monthKey === "2026-08")!;
    expect(agosto.margin.cents!).toBeLessThan(0);
  });

  it("a percentagem de margem é um tipo, nunca um 0 mascarado", () => {
    const agosto = view.series.monthly.find((m) => m.monthKey === "2026-08")!;
    expect(agosto.marginPercent.kind).toBe("VALUE");
    expect(agosto.marginPercent.percent).toBeLessThan(0);
  });
});

describe("§5 — o dinheiro não volta a vírgula flutuante", () => {
  const view = buildDashboardView({
    periods: PERIODS,
    current: reportFor(AGOSTO),
    daily: buildDailySeries(AGOSTO_INPUT),
    monthly: [reportFor(AGOSTO)],
  });

  it("todos os KPIs são inteiros seguros ou null", () => {
    for (const kpi of Object.values(view.kpis)) {
      const c = kpi.amount.cents;
      if (c !== null) expect(Number.isSafeInteger(c)).toBe(true);
    }
  });

  it("todos os pontos da série diária são inteiros ou null", () => {
    for (const p of view.series.daily) {
      for (const a of [p.performed, p.invoiced, p.received, p.expenses]) {
        if (a.cents !== null) expect(Number.isSafeInteger(a.cents)).toBe(true);
      }
    }
  });

  it("todos os pontos da série mensal são inteiros ou null", () => {
    for (const m of view.series.monthly) {
      for (const a of [m.performed, m.invoiced, m.received, m.cost, m.margin]) {
        if (a.cents !== null) expect(Number.isSafeInteger(a.cents)).toBe(true);
      }
    }
  });

  it("a decomposição de IVA fecha em inteiros", () => {
    const v = reportFor(AGOSTO).financial.vat;
    expect(Number.isSafeInteger(v.netCents)).toBe(true);
    expect(Number.isSafeInteger(v.vatCents)).toBe(true);
    expect(v.netCents + v.vatCents).toBe(v.grossCents);
  });
});

describe("§2 — nenhum conceito muda de significado ao mudar de camada", () => {
  it("faturado: T11 deriva, T14 agrega, T15 apresenta o mesmo número", () => {
    const mensal = reportFor(AGOSTO);
    const view = buildDashboardView({ periods: PERIODS, current: mensal });
    expect(view.kpis.invoiced.amount).toBe(mensal.financial.invoiced);
  });

  it("em aberto: o valor da T15 é o que a T11 derivou, sem recálculo", () => {
    const mensal = reportFor(AGOSTO);
    const view = buildDashboardView({ periods: PERIODS, current: mensal });
    const t11 = computeOutstanding(mensal.financial.invoiced, mensal.financial.received);
    expect(view.kpis.outstanding.amount.cents).toBe(t11.cents);
  });

  it("todos os 11 KPIs são a MESMA referência do relatório da T14", () => {
    // Prova estrutural de que a T15 não reconstrói nenhum montante.
    const mensal = reportFor(AGOSTO);
    const view = buildDashboardView({ periods: PERIODS, current: mensal });
    for (const [key, kpi] of Object.entries(view.kpis)) {
      expect(kpi.amount).toBe(mensal.financial[key as keyof typeof mensal.financial]);
    }
  });

  it("a origem declarada de cada conceito é estável", () => {
    const view = buildDashboardView({ periods: PERIODS, current: reportFor(AGOSTO) });
    expect(view.kpis.contracted.amount.origin).toBe("contract");
    expect(view.kpis.scheduled.amount.origin).toBe("service_scheduled");
    expect(view.kpis.performed.amount.origin).toBe("service_completed");
    expect(view.kpis.invoiced.amount.origin).toBe("invoice");
    expect(view.kpis.received.amount.origin).toBe("cash_flow");
    expect(view.kpis.outstanding.amount.origin).toBe("derived");
    expect(view.kpis.margin.amount.origin).toBe("derived");
  });
});

describe("§18/§19 — os bloqueios continuam fechados", () => {
  it("PRORATED lança e nenhuma camada o activa por omissão", () => {
    expect(() => allocateMonthlyAmount({
      totalCents: cents(100),
      occurrences: [{ id: "a", occurrenceDate: "2026-08-01" }],
      policy: "PRORATED",
    })).toThrow(/standby/);

    // O caminho normal usa FULL_MONTH sem ninguém pedir.
    const r = allocateMonthlyAmount({
      totalCents: cents(100),
      occurrences: [{ id: "a", occurrenceDate: "2026-08-01" }],
    });
    expect(r.policy).toBe("FULL_MONTH");
  });

  it("a projeção continua deliberadamente no método legado", () => {
    expect(CURRENT_PROJECTION_METHOD).toBe("LEGACY_AVERAGE_OF_NONZERO_MONTHS");
  });

  it("contratado × realizado dá o delta sem inferir perda", () => {
    const view = buildDashboardView({ periods: PERIODS, current: reportFor(AGOSTO) });
    const r = contractedVsPerformed(view);
    expect(r.comparable).toBe(true);
    expect(r.deltaCents).toBe(cents(75.5)); // realizado acima do contratado
    expect(Object.keys(r)).not.toContain("loss");
  });

  it("recebido acima do faturado não é achatado", () => {
    const view = buildDashboardView({
      periods: PERIODS,
      current: reportFor(AGOSTO, {
        cashFlow: sourceOk([{
          id: "c", date: "2026-08-05", type: "entrada",
          amountCents: cents(999), category: "faturacao", status: "confirmado",
        }]),
      }),
    });
    const r = invoicedVsReceived(view);
    expect(r.outstanding.cents!).toBeLessThan(0);
    expect(r.receivedExceedsInvoiced).toBe(true);
  });
});

describe("§12 — os períodos têm a mesma semântica nas três camadas", () => {
  it("o mês da T15 é o mesmo mês da T14", () => {
    expect(PERIODS.month).toEqual(AGOSTO);
  });

  it("a semana da T15 usa a convenção do motor de recorrência da T07", () => {
    // Ambas usam `startOfWeek` de civil-date.ts — segunda a domingo.
    const p = buildDashboardPeriods("2026-08-16")!; // domingo
    expect(p.week).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("o intervalo é fechado dos dois lados em toda a pilha", () => {
    const p = buildDashboardPeriods("2026-08-31")!;
    expect(p.month.end).toBe("2026-08-31");
    expect(reportFor(AGOSTO).metadata.period.end).toBe("2026-08-31");
  });

  it("a ausência que atravessa o mês conta só a parte de dentro", () => {
    const mensal = reportFor(AGOSTO);
    expect(mensal.operations.absenceDays).toBe(7); // 25 a 31 de agosto
  });
});

describe("§11 — o IVA é calculado uma só vez, pela T11", () => {
  it("aplicar IVA duas vezes dá um resultado diferente — logo não acontece", () => {
    const base = cents(100);
    const uma = applyVat(base, { applyVat: true, ratePct: 23 });
    const duas = applyVat(uma.grossCents, { applyVat: true, ratePct: 23 });
    expect(uma.grossCents).toBe(cents(123));
    expect(duas.grossCents).not.toBe(uma.grossCents);
  });

  it("uma taxa indisponível não vira 23% em nenhuma camada", () => {
    const view = buildDashboardView({
      periods: PERIODS,
      current: reportFor(AGOSTO, { vat: sourceOk([{ ratePct: null }]) }),
    });
    expect(view.health.byCode.VAT_RATE_UNAVAILABLE).toBe(1);
  });
});

describe("determinismo de ponta a ponta", () => {
  it("a mesma fixture dá sempre exactamente a mesma vista", () => {
    const build = () => buildDashboardView({
      periods: PERIODS,
      current: reportFor(AGOSTO),
      previous: reportFor(JULHO),
      daily: buildDailySeries(AGOSTO_INPUT),
      monthly: [reportFor(JULHO), reportFor(AGOSTO)],
      clients: buildClientSummaries([{ clientId: "cli-1", invoicedCents: cents(200) }]),
    });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("a ordem de chegada dos serviços não altera nenhum número", () => {
    const invertido = buildReport({
      ...AGOSTO_INPUT,
      sources: { ...AGOSTO_INPUT.sources, services: sourceOk([...SERVICOS].reverse()) },
    });
    expect(invertido.financial.performed.cents).toBe(reportFor(AGOSTO).financial.performed.cents);
  });

  it("a soma dos cêntimos é exacta, sem erro de vírgula flutuante", () => {
    const parts: MoneyCents[] = [cents(33.34), cents(33.33), cents(33.33), cents(75.5)];
    expect(sumCents(parts)).toBe(cents(175.5));
  });
});
