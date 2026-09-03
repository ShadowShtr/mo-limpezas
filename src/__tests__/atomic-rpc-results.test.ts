import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readServicePaymentResult,
  readBankCashflowResult,
  RPC_UNEXPECTED_SHAPE_MESSAGE,
} from "@/lib/atomic-rpc-results";

// ============================================================================
// Duas regressões que o encaminhamento dos writers para as RPCs atómicas
// introduziu, e que só se veem no que fica GRAVADO — nunca no ecrã:
//
//   1. `setServicePayment` chamava `set_service_payment_atomic` e deitava fora
//      o retorno, com a auditoria `billing.payment_status_changed` perdida
//      pelo caminho. Sem ela não há como saber de que estado veio um pagamento
//      nem quanto entrou em caixa.
//
//   2. `createEntryFromTransaction` auditava `entityType: "cash_flow_entry"`
//      com `entityId: bankTransactionId` — o id da entidade errada. O registo
//      apontava para uma linha que a operação não criou.
//
// Em ambos os casos a autoridade é a RPC: os identificadores e o valor
// económico vêm de lá, não de um recálculo deste lado.
// ============================================================================

const SERVICE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ENTRY = "11111111-2222-4333-8444-555555555555";
const MATCH = "99999999-8888-4777-8666-555555555555";
const BANK_TX = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("097 — leitura do resultado de set_service_payment_atomic", () => {
  it("aceita a linha esperada e devolve o valor que a RPC gravou", () => {
    const r = readServicePaymentResult([{ service_id: SERVICE, cash_amount: 123.45 }], SERVICE);
    expect(r).toEqual({ ok: true, serviceId: SERVICE, cashAmount: 123.45 });
  });

  it("aceita numeric devolvido como texto pelo driver", () => {
    const r = readServicePaymentResult([{ service_id: SERVICE, cash_amount: "123.45" }], SERVICE);
    expect(r.ok && r.cashAmount).toBe(123.45);
  });

  it("aceita zero — não pagar nada é um resultado legítimo", () => {
    const r = readServicePaymentResult([{ service_id: SERVICE, cash_amount: 0 }], SERVICE);
    expect(r.ok && r.cashAmount).toBe(0);
  });

  it.each([
    ["sem linhas", []],
    ["mais do que uma linha", [{ service_id: SERVICE, cash_amount: 1 }, { service_id: SERVICE, cash_amount: 2 }]],
    ["não é um array", { service_id: SERVICE, cash_amount: 1 }],
    ["null", null],
    ["sem cash_amount", [{ service_id: SERVICE }]],
    ["cash_amount nulo", [{ service_id: SERVICE, cash_amount: null }]],
    ["cash_amount não numérico", [{ service_id: SERVICE, cash_amount: "quase" }]],
    ["service_id em falta", [{ cash_amount: 10 }]],
    ["service_id que não é uuid", [{ service_id: "servico-1", cash_amount: 10 }]],
  ])("fail-closed: %s", (_caso, resposta) => {
    const r = readServicePaymentResult(resposta, SERVICE);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe(RPC_UNEXPECTED_SHAPE_MESSAGE);
  });

  // Deliberadamente com ids diferentes: uma confirmação sobre OUTRO serviço
  // não confirma este, e tratá-la como sucesso auditaria o serviço errado.
  it("fail-closed: a RPC confirma um serviço diferente do pedido", () => {
    const outro = "00000000-0000-4000-8000-000000000001";
    const r = readServicePaymentResult([{ service_id: outro, cash_amount: 50 }], SERVICE);
    expect(r.ok).toBe(false);
  });

  it("o uuid é comparado sem depender de maiúsculas", () => {
    const r = readServicePaymentResult([{ service_id: SERVICE.toUpperCase(), cash_amount: 5 }], SERVICE);
    expect(r.ok).toBe(true);
  });
});

describe("095 — leitura do resultado de create_cashflow_from_bank_transaction_atomic", () => {
  it("devolve o id do movimento criado e o match", () => {
    const r = readBankCashflowResult([{ entry_id: ENTRY, match_id: MATCH }]);
    expect(r).toEqual({ ok: true, entryId: ENTRY, matchId: MATCH });
  });

  it("match_id vazio é legítimo — nem toda a criação vem de uma sugestão", () => {
    const r = readBankCashflowResult([{ entry_id: ENTRY, match_id: null }]);
    expect(r).toEqual({ ok: true, entryId: ENTRY, matchId: null });
  });

  // Com ids deliberadamente diferentes: se o leitor confundisse os campos, o
  // entryId sairia com o valor do match e a auditoria apontaria para o objeto
  // errado sem ninguém dar por isso.
  it("não confunde entry_id com match_id", () => {
    const r = readBankCashflowResult([{ entry_id: ENTRY, match_id: MATCH }]);
    expect(r.ok && r.entryId).toBe(ENTRY);
    expect(r.ok && r.entryId).not.toBe(MATCH);
    expect(r.ok && r.entryId).not.toBe(BANK_TX);
  });

  it.each([
    ["sem linhas", []],
    ["duas linhas", [{ entry_id: ENTRY }, { entry_id: ENTRY }]],
    ["não é um array", { entry_id: ENTRY }],
    ["entry_id em falta", [{ match_id: MATCH }]],
    ["entry_id nulo", [{ entry_id: null, match_id: MATCH }]],
    ["entry_id que não é uuid", [{ entry_id: "entrada-1" }]],
    ["match_id presente mas inválido", [{ entry_id: ENTRY, match_id: "match-1" }]],
  ])("fail-closed: %s", (_caso, resposta) => {
    const r = readBankCashflowResult(resposta);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe(RPC_UNEXPECTED_SHAPE_MESSAGE);
  });
});

// ============================================================================
// Os call-sites. O que interessa não é só o leitor existir, é ele estar ligado
// e a auditoria voltar a ser escrita com os campos certos.
// ============================================================================

const SRC = join(__dirname, "..", "app", "actions");
const dailyBilling = readFileSync(join(SRC, "daily-billing.ts"), "utf8");
const bankRecon = readFileSync(join(SRC, "bank-reconciliation.ts"), "utf8");

describe("setServicePayment — autoridade e auditoria", () => {
  it("a autoridade económica continua a ser a RPC 097", () => {
    expect(dailyBilling).toContain(`admin.rpc("set_service_payment_atomic"`);
  });

  it("não reintroduz escritas diretas em cash_flow_entries", () => {
    expect(dailyBilling).not.toContain(`.from("cash_flow_entries").insert`);
    expect(dailyBilling).not.toContain(`.from("cash_flow_entries")\n      .update`);
    expect(dailyBilling).not.toMatch(/from\("cash_flow_entries"\)[\s\S]{0,60}\.(insert|update|delete)\(/);
  });

  it("não recalcula o valor de caixa deste lado", () => {
    expect(dailyBilling).not.toContain("computeServiceBillingValue");
    expect(dailyBilling).not.toContain("syncServicePaymentCashFlow");
  });

  it("consome o retorno da RPC antes de auditar", () => {
    expect(dailyBilling).toContain("readServicePaymentResult");
    expect(dailyBilling.indexOf("readServicePaymentResult"))
      .toBeLessThan(dailyBilling.indexOf("billing.payment_status_changed"));
  });

  it("a auditoria voltou, com a entidade e os metadados certos", () => {
    expect(dailyBilling).toContain(`action: "billing.payment_status_changed"`);
    expect(dailyBilling).toContain(`entityType: "service"`);
    expect(dailyBilling).toContain("entityId: serviceId");
    expect(dailyBilling).toContain("cash_flow_amount: confirmacao.cashAmount");
    expect(dailyBilling).toContain("paid_amount:");
    expect(dailyBilling).toContain("from: antes.payment_status");
    expect(dailyBilling).toContain("to: status");
  });
});

describe("createEntryFromTransaction — a entidade auditada é o movimento", () => {
  it("a autoridade continua a ser a RPC 095", () => {
    expect(bankRecon).toContain(`admin.rpc("create_cashflow_from_bank_transaction_atomic"`);
  });

  it("consome o retorno antes de auditar", () => {
    expect(bankRecon).toContain("readBankCashflowResult");
    expect(bankRecon.indexOf("readBankCashflowResult"))
      .toBeLessThan(bankRecon.indexOf(`action: "bank_entry_created"`));
  });

  it("audita o entry_id da RPC, nunca o bankTransactionId", () => {
    expect(bankRecon).toContain(`entityType: "cash_flow_entry", entityId: criado.entryId`);
    expect(bankRecon).not.toContain(`entityType: "cash_flow_entry", entityId: bankTransactionId`);
  });

  it("o movimento bancário e o match ficam nos metadados", () => {
    expect(bankRecon).toContain("bank_transaction_id: bankTransactionId");
    expect(bankRecon).toContain("match_id: criado.matchId");
  });
});
