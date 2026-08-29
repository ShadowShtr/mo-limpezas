// ============================================================================
// O contrato entre a UI e a RPC de marcar como pago
// ============================================================================
//
// `marcarPagamentoPago` é a fronteira entre quem clica e a 073/079. Tudo o que
// a UI vai mostrar sai daqui — e o que interessa não é só o caminho feliz.
//
// 🔴 A regra que sustenta o resto: **a identidade do movimento vem da base, ou
//    não vem.** O cliente nunca a inventa. Se a resposta não trouxer um
//    `cash_entry_id`, isto falha fechado. Tratá-la como sucesso diria à gestora
//    que o dinheiro ficou registado quando ninguém sabe se ficou — e essa é a
//    mentira cara, porque ela não vai lá confirmar.
//
// Os ensaios usam um cliente falso: o que se mede é o contrato do helper, não
// o comportamento do PostgreSQL. Esse está provado noutro sítio, contra uma
// base real.
// ============================================================================

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

/** Cliente que devolve um erro da base, como o PostgREST o entrega. */
function clientErro(error: { message: string; code?: string }) {
  const rpc = vi.fn(async () => ({ data: null, error }));
  return { rpc } as ClienteRpc & { rpc: ReturnType<typeof vi.fn> };
}

const ENTRADA = { companyId: COMPANY, paymentId: PAYMENT, paidOn: "2026-08-27" };

describe("nova UI e F14-A - contrato de pagamento e caixa", () => {
  it("A. primeira marcacao devolve a identidade canonica do movimento", async () => {
    const api = client([[{ cash_entry_id: CASHFLOW, ja_estava_pago: false }]]);
    const result = await marcarPagamentoPago(api, ENTRADA);

    expect(result).toEqual({ ok: true, movimentoId: CASHFLOW, jaEstavaPago: false });
    expect(api.rpc).toHaveBeenCalledWith(RPC_MARCAR_PAGO, {
      p_company_id: COMPANY,
      p_payment_id: PAYMENT,
      p_paid_on: "2026-08-27",
    });
  });

  it("B+C. retry devolve o mesmo cashflow, e diz que ja estava pago", async () => {
    const api = client([
      [{ cash_entry_id: CASHFLOW, ja_estava_pago: false }],
      [{ cash_entry_id: CASHFLOW, ja_estava_pago: true }],
    ]);
    const first = await marcarPagamentoPago(api, ENTRADA);
    const retry = await marcarPagamentoPago(api, ENTRADA);

    expect(first.ok && first.movimentoId).toBe(CASHFLOW);
    expect(retry.ok && retry.movimentoId).toBe(CASHFLOW);
    expect(retry.ok && retry.jaEstavaPago).toBe(true);
    expect(api.rpc).toHaveBeenCalledTimes(2);
  });

  it("D. resposta sem cashflow falha fechada e nao vira sucesso de UI", async () => {
    const api = client([[{ ja_estava_pago: false }]]);
    const result = await marcarPagamentoPago(api, ENTRADA);

    expect(result).toMatchObject({ ok: false, motivo: "respostaInesperada" });
  });

  it("🔴 F. e nenhuma identidade e inventada quando a base nao a da", async () => {
    // O ponto do D é a recusa; o ponto do F é o que **não** aparece no
    // resultado. Um `movimentoId` fabricado — string vazia, uuid gerado no
    // cliente, o próprio id do pagamento — daria à UI algo com que trabalhar,
    // e a partir daí ninguém distinguiria um movimento real de um inventado.
    for (const resposta of [
      [{ ja_estava_pago: false }],           // sem cash_entry_id
      [{ cash_entry_id: null, ja_estava_pago: false }],
      [{ cash_entry_id: CASHFLOW }],         // sem ja_estava_pago
      [{ cash_entry_id: CASHFLOW, ja_estava_pago: "sim" }],
      [],                                    // nenhuma linha
      null,                                  // nem sequer um array
    ]) {
      const r = await marcarPagamentoPago(client([resposta]), ENTRADA);
      expect(r.ok, JSON.stringify(resposta)).toBe(false);
      expect(Object.keys(r)).not.toContain("movimentoId");
      expect(Object.keys(r)).not.toContain("jaEstavaPago");
    }
  });

  it("E. os tres argumentos vao exactos, e mais nenhum", async () => {
    // O `company_id` resolve-se no servidor e chega aqui já resolvido. Se um
    // argumento a mais passasse, a RPC recusaria — mas o erro apareceria longe
    // daqui, e a causa não seria óbvia.
    const api = client([[{ cash_entry_id: CASHFLOW, ja_estava_pago: false }]]);
    await marcarPagamentoPago(api, ENTRADA);

    const [nome, args] = api.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(nome).toBe(RPC_MARCAR_PAGO);
    expect(Object.keys(args).sort()).toEqual(["p_company_id", "p_paid_on", "p_payment_id"].sort());
  });

  it("um erro da base chega ao chamador, sem virar sucesso", async () => {
    const api = clientErro({ message: "FINANCIAL_PERIOD_CLOSED", code: "P0001" });
    const r = await marcarPagamentoPago(api, ENTRADA);
    expect(r.ok).toBe(false);
    expect(Object.keys(r)).not.toContain("movimentoId");
  });

  it("argumentos invalidos nem chegam a base", async () => {
    const api = client([[{ cash_entry_id: CASHFLOW, ja_estava_pago: false }]]);
    const r = await marcarPagamentoPago(api, { ...ENTRADA, paidOn: "27/08/2026" });
    expect(r).toMatchObject({ ok: false, motivo: "argumentosInvalidos" });
    expect(api.rpc).not.toHaveBeenCalled();
  });
});
