import { describe, expect, it, vi } from "vitest";
import {
  marcarPagamentoPago,
  RPC_MARCAR_PAGO,
  type ClienteRpc,
} from "@/lib/finance-rpc/payment-cashflow";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PAYMENT = "22222222-2222-4222-8222-222222222222";
const CASHFLOW = "33333333-3333-4333-8333-333333333333";

function client(rows: unknown[]): ClienteRpc & { rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async () => ({ data: rows.shift(), error: null }));
  return { rpc };
}

describe("nova UI e F14-A - contrato de pagamento e caixa", () => {
  it("primeira marcacao devolve a identidade canonica do movimento", async () => {
    const api = client([[{ cash_entry_id: CASHFLOW, ja_estava_pago: false }]]);
    const result = await marcarPagamentoPago(api, {
      companyId: COMPANY,
      paymentId: PAYMENT,
      paidOn: "2026-08-27",
    });

    expect(result).toEqual({ ok: true, movimentoId: CASHFLOW, jaEstavaPago: false });
    expect(api.rpc).toHaveBeenCalledWith(RPC_MARCAR_PAGO, {
      p_company_id: COMPANY,
      p_payment_id: PAYMENT,
      p_paid_on: "2026-08-27",
    });
  });

  it("retry devolve o mesmo cashflow, sem criar uma segunda identidade", async () => {
    const api = client([
      [{ cash_entry_id: CASHFLOW, ja_estava_pago: false }],
      [{ cash_entry_id: CASHFLOW, ja_estava_pago: true }],
    ]);
    const input = { companyId: COMPANY, paymentId: PAYMENT, paidOn: "2026-08-27" };
    const first = await marcarPagamentoPago(api, input);
    const retry = await marcarPagamentoPago(api, input);

    expect(first.ok && first.movimentoId).toBe(CASHFLOW);
    expect(retry.ok && retry.movimentoId).toBe(CASHFLOW);
    expect(retry.ok && retry.jaEstavaPago).toBe(true);
    expect(api.rpc).toHaveBeenCalledTimes(2);
  });

  it("resposta sem cashflow falha fechada e nao vira sucesso de UI", async () => {
    const api = client([[{ ja_estava_pago: false }]]);
    const result = await marcarPagamentoPago(api, {
      companyId: COMPANY,
      paymentId: PAYMENT,
      paidOn: "2026-08-27",
    });

    expect(result).toMatchObject({ ok: false, motivo: "respostaInesperada" });
  });
});
