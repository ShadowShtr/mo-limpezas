"use server";

// ============================================================================
// Histórico financeiro do cliente — leitura
// ============================================================================
//
// 🔴 Só leitura. Nenhum `insert`, `update`, `delete` ou `upsert`.
//
// Responde às duas perguntas que a gestão fez: quanto é que este cliente pagou
// em cada mês, e quanto já pagou no ano.
// ============================================================================

import { requireProfile } from "@/lib/auth-guard";

import {
  montarHistoricoCliente,
  type FactoNotaCobranca,
  type HistoricoCliente,
} from "@/domain/finance-v2/client-history";
import type { FactoFatura, Fonte } from "@/domain/finance-v2/aggregate";
import { billingReceived, billingTotal } from "@/domain/billing/daily-billing";
import { lisbonDateOf } from "@/lib/lisbon-time";

export async function getClientFinancialHistory(
  input: { clientId: string; year: number },
): Promise<{ ok: true; data: HistoricoCliente } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // 🔴 O filtro por empresa **e** por cliente é explícito aqui, e não depende
  //    de quem chamou ter filtrado antes. Um relatório financeiro que mistura
  //    clientes é pior do que um relatório que não existe.
  //
  //    Faturas e cobranças avulsas são origens distintas, lidas em paralelo. É
  //    o domínio que decide o que soma em recebido e em aberto — e uma
  //    cobrança avulsa NUNCA entra em «faturado»: não é uma fatura.
  const [invoiceResult, manualResult, settingsResult] = await Promise.all([
    admin
      .from("invoices")
      .select("id, status, total, due_date, paid_at, period_start, client_id")
      .eq("company_id", companyId)
      .eq("client_id", input.clientId),
    admin
      .from("manual_charges")
      .select("id, client_id, charge_date, amount, apply_vat, payment_status, paid_amount, paid_at")
      .eq("company_id", companyId)
      .eq("client_id", input.clientId)
      // Anulada não é dívida nem recebimento: fica fora do histórico.
      .is("voided_at", null),
    admin.from("company_settings").select("vat_rate").eq("company_id", companyId).maybeSingle(),
  ]);

  // Sem IVA conhecido, o total de uma cobrança avulsa com IVA seria um palpite
  // — e 23% assumido às escuras parece configuração da empresa. Falha a fonte
  // das notas, não se inventa a taxa.
  if (settingsResult.error) {
    console.error("[getClientFinancialHistory] company_settings", settingsResult.error.message);
    return { ok: false, error: "Não foi possível ler as configurações da empresa." };
  }
  const vatRaw = settingsResult.data?.vat_rate;
  const vatRate = vatRaw == null ? null : Number(vatRaw);
  const vatConhecido = vatRate !== null && Number.isFinite(vatRate) && vatRate >= 0;
  const precisaDeIva = (manualResult.data ?? []).some((r) => r.apply_vat);

  // Sem `data ?? []`: uma query rebentada tem de chegar ao ecrã como erro, não
  // como um ano em que o cliente não pagou nada.
  const notas: Fonte<FactoNotaCobranca> = manualResult.error
    ? { ok: false, erro: manualResult.error.message }
    : precisaDeIva && !vatConhecido
      ? { ok: false, erro: "Taxa de IVA da empresa indisponível." }
      : {
        ok: true,
        factos: (manualResult.data ?? []).map((r) => {
          // A MESMA regra de valor e recebido do Diário — uma função, não uma
          // segunda cópia da fórmula.
          const linha = {
            type: "manual_charge" as const,
            id: r.id,
            charge_date: r.charge_date,
            description: "",
            client_id: r.client_id,
            client_name: "",
            value: Number(r.amount),
            apply_vat: r.apply_vat,
            payment_status: r.payment_status,
            paid_amount: r.paid_amount == null ? null : Number(r.paid_amount),
            paid_at: r.paid_at,
            notes: null,
          };
          return {
            id: r.id,
            clientId: r.client_id,
            chargeDate: r.charge_date,
            total: billingTotal(linha, vatRate ?? 0),
            received: billingReceived(linha, vatRate ?? 0),
            // O mês do recebimento é o do dia civil em Lisboa — o mesmo em que
            // a RPC grava o movimento de caixa. `paid_at` é um instante UTC.
            paidAt: r.paid_at ? lisbonDateOf(r.paid_at) : null,
          };
        }),
      };

  const faturas: Fonte<FactoFatura> = invoiceResult.error
    ? { ok: false, erro: invoiceResult.error.message }
    : {
        ok: true,
        factos: (invoiceResult.data ?? []).map((r) => ({
          id: r.id,
          status: r.status,
          total: Number(r.total ?? 0),
          dueDate: r.due_date,
          paidAt: r.paid_at,
          periodStart: r.period_start,
          clientId: r.client_id,
          clientName: null,
        })),
      };

  return { ok: true, data: montarHistoricoCliente(faturas, input.clientId, input.year, undefined, notas) };
}

/** A lista de clientes para o seletor. Nome e id, mais nada. */
export async function listClientsForFinance(): Promise<
  { ok: true; clients: { id: string; name: string }[] } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const { data, error } = await guard.admin
    .from("clients")
    .select("id, name")
    .eq("company_id", guard.profile.company_id)
    .order("name", { ascending: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true, clients: (data ?? []).map((c) => ({ id: c.id, name: c.name })) };
}
