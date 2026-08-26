import { describe, expect, it, vi } from "vitest";
import {
  RPC_ESTADO_FATURA,
  alterarEstadoFatura,
  construirArgumentosEstadoFatura,
  interpretarRespostaEstadoFatura,
  type EntradaEstadoFatura,
} from "@/lib/finance-rpc/invoice-status";
import type { ClienteRpc } from "@/lib/finance-rpc/payment-cashflow";

const input: EntradaEstadoFatura = {
  invoiceId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  actorId: "33333333-3333-4333-8333-333333333333",
  status: "pago",
  paymentMethod: "transferencia",
  mutationId: "44444444-4444-4444-8444-444444444444",
  expectedRevision: 7,
};

describe("contrato TypeScript de set_invoice_status_atomic", () => {
  it("envia os sete argumentos pelos nomes SQL", () => {
    const result = construirArgumentosEstadoFatura(input);
    expect(result).toEqual({
      ok: true,
      args: {
        p_invoice_id: input.invoiceId,
        p_company_id: input.companyId,
        p_actor: input.actorId,
        p_status: "pago",
        p_payment_method: "transferencia",
        p_mutation_id: input.mutationId,
        p_expected_revision: 7,
      },
    });
  });

  it("argumentos inválidos falham antes da RPC", async () => {
    const rpc = vi.fn();
    const result = await alterarEstadoFatura({ rpc } as unknown as ClienteRpc, {
      ...input,
      invoiceId: "não-é-uuid",
    });
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("interpreta sucesso, revisão, caixa e no-op", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        invoice: { revision: 8 },
        cash_flow_entry: { id: "55555555-5555-4555-8555-555555555555" },
        no_change: false,
      },
      error: null,
    });
    const result = await alterarEstadoFatura({ rpc } as unknown as ClienteRpc, input);
    expect(rpc).toHaveBeenCalledWith(RPC_ESTADO_FATURA, expect.objectContaining({ p_expected_revision: 7 }));
    expect(result).toEqual({
      ok: true,
      revision: 8,
      cashFlowEntryId: "55555555-5555-4555-8555-555555555555",
      noChange: false,
    });
  });

  it.each([
    ["REVISION_CONFLICT", /outro ecrã/],
    ["FINANCIAL_PERIOD_CLOSED", /período financeiro/],
    ["RECONCILED_CASHFLOW", /conciliado/],
    ["CASHFLOW_INVOICE_MISMATCH", /divergem/],
  ])("traduz %s sem esconder a causa", (code, message) => {
    const result = interpretarRespostaEstadoFatura({ data: { ok: false, code }, error: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it("RPC ausente falha fechada", () => {
    const result = interpretarRespostaEstadoFatura({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    expect(result).toEqual({
      ok: false,
      code: "RPC_MISSING",
      error: "A operação atómica de faturas ainda não está disponível nesta base.",
    });
  });
});
