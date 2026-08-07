// ============================================================================
// T11 — Modelo financeiro canónico
// ============================================================================
// Fixa o vocabulário: realizado ≠ faturado ≠ recebido, e null ≠ zero.

import { describe, it, expect } from "vitest";
import {
  aggregatePeriods,
  amount,
  buildSummary,
  centsOrZero,
  computeMargin,
  computeOutstanding,
  emptySummary,
  unavailable,
  weakestCompleteness,
  type FinancialPeriod,
} from "@/domain/billing/financial-model";
import { type MoneyCents } from "@/domain/billing/money";

const c = (n: number) => n as MoneyCents;

describe("montantes com proveniência", () => {
  it("um montante conhecido traz origem e completude", () => {
    const a = amount(c(10000), "invoice");
    expect(a).toMatchObject({ cents: 10000, origin: "invoice", completeness: "COMPLETE" });
  });

  it("indisponível é null, nunca zero", () => {
    const a = unavailable("cash_flow", "caixa não carregada");
    expect(a.cents).toBeNull();
    expect(a.completeness).toBe("UNAVAILABLE");
    // Zero legítimo é outra coisa, e tem de continuar distinguível.
    expect(amount(c(0), "cash_flow").cents).toBe(0);
  });

  it("centsOrZero trata indisponível como zero só para agregar", () => {
    expect(centsOrZero(unavailable("invoice", "x"))).toBe(0);
    expect(centsOrZero(amount(c(500), "invoice"))).toBe(500);
  });

  it("a completude mais fraca vence", () => {
    expect(weakestCompleteness([amount(c(1), "invoice")])).toBe("COMPLETE");
    expect(
      weakestCompleteness([amount(c(1), "invoice"), amount(c(1), "invoice", "PARTIAL")]),
    ).toBe("PARTIAL");
    expect(
      weakestCompleteness([amount(c(1), "invoice", "PARTIAL"), unavailable("invoice", "x")]),
    ).toBe("UNAVAILABLE");
  });
});

describe("em aberto", () => {
  it("é faturado menos recebido", () => {
    const r = computeOutstanding(amount(c(12300), "invoice"), amount(c(5000), "cash_flow"));
    expect(r.cents).toBe(7300);
    expect(r.origin).toBe("derived");
  });

  it("um pagamento parcial deixa parte em aberto", () => {
    // O defeito antigo: "recebido" era o estado da fatura, e uma fatura
    // parcialmente paga contava como zero recebido ou como tudo recebido.
    const r = computeOutstanding(amount(c(10000), "invoice"), amount(c(3000), "cash_flow"));
    expect(r.cents).toBe(7000);
  });

  it("recebido a mais dá valor negativo em vez de zero silencioso", () => {
    const r = computeOutstanding(amount(c(10000), "invoice"), amount(c(12000), "cash_flow"));
    expect(r.cents).toBe(-2000);
  });

  it("propaga indisponibilidade em vez de inventar zero", () => {
    const r = computeOutstanding(unavailable("invoice", "x"), amount(c(5000), "cash_flow"));
    expect(r.cents).toBeNull();
    expect(r.completeness).toBe("UNAVAILABLE");
  });
});

describe("margem", () => {
  const parts = {
    performed: amount(c(10000), "service_completed"),
    invoiced: amount(c(8000), "invoice"),
    received: amount(c(5000), "cash_flow"),
    cost: amount(c(3000), "payroll"),
  };

  it("a base muda o número — por isso é explícita", () => {
    expect(computeMargin(parts, "performed").cents).toBe(7000);
    expect(computeMargin(parts, "invoiced").cents).toBe(5000);
    expect(computeMargin(parts, "received").cents).toBe(2000);
  });

  it("custo indisponível torna a margem indisponível", () => {
    const r = computeMargin({ ...parts, cost: unavailable("payroll", "x") }, "invoiced");
    expect(r.cents).toBeNull();
  });
});

describe("resumo", () => {
  it("deriva em aberto e margem — nenhum consumidor os calcula", () => {
    const s = buildSummary({
      contracted: amount(c(30000), "contract"),
      scheduled: amount(c(30000), "service_scheduled"),
      performed: amount(c(20000), "service_completed"),
      invoiced: amount(c(30000), "invoice"),
      received: amount(c(10000), "cash_flow"),
      overdue: amount(c(5000), "invoice"),
      cost: amount(c(8000), "payroll"),
    });
    expect(s.outstanding.cents).toBe(20000);
    expect(s.margin.cents).toBe(22000); // base invoiced por omissão
  });

  it("realizado, faturado e recebido são grandezas distintas", () => {
    const s = buildSummary({
      contracted: amount(c(30000), "contract"),
      scheduled: amount(c(30000), "service_scheduled"),
      performed: amount(c(20000), "service_completed"),
      invoiced: amount(c(30000), "invoice"),
      received: amount(c(0), "cash_flow"),
      overdue: amount(c(0), "invoice"),
      cost: amount(c(0), "payroll"),
    });
    // Meio mês por realizar, tudo faturado, nada recebido: três números
    // diferentes que antes apareciam todos como "receita".
    expect(s.performed.cents).not.toBe(s.invoiced.cents);
    expect(s.invoiced.cents).not.toBe(s.received.cents);
  });

  it("o resumo vazio não finge zeros", () => {
    const s = emptySummary();
    expect(s.contracted.cents).toBeNull();
    expect(s.margin.cents).toBeNull();
  });
});

describe("agregação de períodos", () => {
  const period = (key: string, invoiced: number, received: number): FinancialPeriod => ({
    key,
    start: `${key}-01`,
    end: `${key}-28`,
    summary: buildSummary({
      contracted: amount(c(10000), "contract"),
      scheduled: amount(c(10000), "service_scheduled"),
      performed: amount(c(10000), "service_completed"),
      invoiced: amount(c(invoiced), "invoice"),
      received: amount(c(received), "cash_flow"),
      overdue: amount(c(0), "invoice"),
      cost: amount(c(2000), "payroll"),
    }),
  });

  it("soma parcelas e recalcula os derivados", () => {
    const total = aggregatePeriods([
      period("2026-06", 10000, 4000),
      period("2026-07", 10000, 6000),
    ]);
    expect(total.invoiced.cents).toBe(20000);
    expect(total.received.cents).toBe(10000);
    expect(total.outstanding.cents).toBe(10000);
    expect(total.cost.cents).toBe(4000);
  });

  it("um período sem dados contamina a completude, não o total", () => {
    const incompleto: FinancialPeriod = {
      key: "2026-08",
      start: "2026-08-01",
      end: "2026-08-31",
      summary: emptySummary("mês por carregar"),
    };
    const total = aggregatePeriods([period("2026-06", 10000, 4000), incompleto]);
    expect(total.invoiced.completeness).toBe("UNAVAILABLE");
    expect(total.invoiced.cents).toBeNull();
  });

  it("sem períodos devolve o resumo vazio", () => {
    expect(aggregatePeriods([]).contracted.cents).toBeNull();
  });
});
