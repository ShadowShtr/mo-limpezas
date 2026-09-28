// Regras puras da união serviço / cobrança avulsa no Diário.

import { describe, expect, it } from "vitest";
import {
  billingOutstanding,
  billingReceived,
  billingRowCivilDate,
  billingRowKey,
  billingTotal,
  dailyBillingKpis,
  hasRegisteredPayment,
  isPendingReceivable,
  statusForCustomAmount,
  type ManualChargeBillingRow,
  type ServiceBillingRow,
} from "@/domain/billing/daily-billing";

const servico = (over: Partial<ServiceBillingRow> = {}): ServiceBillingRow => ({
  type: "service", id: "s1", reference_number: "R1", scheduled_start: "2026-09-12T08:00:00Z",
  status: "concluido", client_id: "c1", client_name: "A", location_name: "Loja", value: 100,
  apply_vat: true, is_avenca: false, payment_status: "nao_informado", paid_amount: null, paid_at: null,
  notes: null, ...over,
});

const avulsa = (over: Partial<ManualChargeBillingRow> = {}): ManualChargeBillingRow => ({
  type: "manual_charge", id: "m1", charge_date: "2026-09-12", description: "Vidros", client_id: "c1",
  client_name: "A", value: 50, apply_vat: false, payment_status: "nao_informado", paid_amount: null,
  paid_at: null, notes: null, ...over,
});

describe("uma regra de valor para os dois tipos", () => {
  it("total com IVA, 50 %, 100 % e valor livre valem o mesmo nos dois", () => {
    for (const row of [servico({ value: 100 }), avulsa({ value: 100, apply_vat: true })]) {
      expect(billingTotal(row, 23)).toBe(123);
      expect(billingReceived({ ...row, payment_status: "sinal_50" }, 23)).toBe(61.5);
      expect(billingReceived({ ...row, payment_status: "pago_total" }, 23)).toBe(123);
      expect(billingReceived({ ...row, payment_status: "sinal_50", paid_amount: 40 }, 23)).toBe(40);
      expect(billingOutstanding({ ...row, payment_status: "sinal_50", paid_amount: 40 }, 23)).toBe(83);
    }
  });

  it("um recebimento maior do que o total não faz a linha valer mais", () => {
    expect(billingReceived(avulsa({ value: 10, payment_status: "pago_total", paid_amount: 999 }), 23)).toBe(10);
  });

  it("valor livre → estado coerente (as RPCs recusam o incoerente)", () => {
    expect(statusForCustomAmount(123, 123)).toBe("pago_total");
    expect(statusForCustomAmount(40, 123)).toBe("sinal_50");
    expect(statusForCustomAmount(0, 123)).toBe("nao_informado");
  });
});

describe("KPIs sobre a união — sem contagem dupla", () => {
  it("🔴 serviço + avulsa somam cada um uma vez", () => {
    const k = dailyBillingKpis([servico(), avulsa()], [], 23);
    expect(k.total).toBe(173);
    expect(k.counts).toMatchObject({ day: 2, services: 1, manualCharges: 1 });
  });

  it("🔴 a mesma linha repetida na lista conta UMA vez", () => {
    const k = dailyBillingKpis([avulsa(), avulsa()], [avulsa({ id: "p", charge_date: "2026-09-01" }), avulsa({ id: "p", charge_date: "2026-09-01" })], 23);
    expect(k.total).toBe(50);
    expect(k.counts.pending).toBe(1);
    expect(k.pendingTotal).toBe(50);
  });

  it("🔴 serviço e avulsa com o MESMO id não colidem — a chave inclui o tipo", () => {
    expect(billingRowKey(servico({ id: "x" }))).not.toBe(billingRowKey(avulsa({ id: "x" })));
    expect(dailyBillingKpis([servico({ id: "x" }), avulsa({ id: "x" })], [], 23).counts.day).toBe(2);
  });

  it("recebido e por receber fecham com o total", () => {
    const k = dailyBillingKpis([servico({ payment_status: "sinal_50" }), avulsa({ payment_status: "pago_total" })], [], 23);
    expect(k.received).toBe(111.5);
    expect(k.outstanding).toBe(61.5);
    expect(k.received + k.outstanding).toBe(k.total);
  });
});

describe("pendentes — a mesma regra nos dois tipos", () => {
  it("🔴 avulsa por receber é pendente", () => {
    expect(isPendingReceivable(avulsa(), 23)).toBe(true);
  });
  it("paga a 100 % sai", () => {
    expect(isPendingReceivable(avulsa({ payment_status: "pago_total" }), 23)).toBe(false);
    expect(isPendingReceivable(servico({ payment_status: "pago_total" }), 23)).toBe(false);
  });
  it("avença não entra nos pendentes — cobra-se pela mensalidade", () => {
    expect(isPendingReceivable(servico({ is_avenca: true }), 23)).toBe(false);
  });
  it("valor zero não é dívida", () => {
    expect(isPendingReceivable(servico({ value: 0 }), 23)).toBe(false);
  });
});

describe("datas e dinheiro registado", () => {
  it("a data civil do serviço é a de Lisboa, não a UTC", () => {
    // 23:30 UTC de 12/09 já é dia 13 em Lisboa (UTC+1 no verão).
    expect(billingRowCivilDate(servico({ scheduled_start: "2026-09-12T23:30:00Z" }))).toBe("2026-09-13");
    expect(billingRowCivilDate(avulsa({ charge_date: "2026-09-12" }))).toBe("2026-09-12");
  });
  it("tem dinheiro = estado ≠ por pagar ou valor > 0", () => {
    expect(hasRegisteredPayment(avulsa())).toBe(false);
    expect(hasRegisteredPayment(avulsa({ payment_status: "sinal_50" }))).toBe(true);
    expect(hasRegisteredPayment(avulsa({ paid_amount: 5 }))).toBe(true);
  });
});
