"use server";

// ============================================================================
// Histórico financeiro do cliente — leitura
// ============================================================================
// 🔴 Só leitura. Nenhum `insert`, `update`, `delete` ou `upsert`.
// ============================================================================

import { requireProfile } from "@/lib/auth-guard";
import { database086Client } from "@/types/database-086";
import {
  montarHistoricoCliente,
  type FactoNotaCobranca,
  type HistoricoCliente,
} from "@/domain/finance-v2/client-history";
import type { FactoFatura, Fonte } from "@/domain/finance-v2/aggregate";

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function getClientFinancialHistory(
  input: { clientId: string; year: number },
): Promise<{ ok: true; data: HistoricoCliente } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const { admin } = guard;
  const db086 = database086Client(admin);
  const companyId = guard.profile.company_id;

  // Faturas e notas são origens distintas. Lemos em paralelo e só o domínio
  // puro decide o que soma em recebido/em aberto; `invoiced` nunca recebe nota.
  const [invoiceResult, manualResult, settingsResult] = await Promise.all([
    admin
      .from("invoices")
      .select("id, status, total, due_date, paid_at, period_start, client_id")
      .eq("company_id", companyId)
      .eq("client_id", input.clientId),
    db086
      .from("manual_charges")
      .select("id, client_id, charge_date, amount, apply_vat, payment_status, paid_amount, paid_at")
      .eq("company_id", companyId)
      .eq("client_id", input.clientId)
      .is("voided_at", null),
    admin
      .from("company_settings")
      .select("vat_rate")
      .eq("company_id", companyId)
      .single(),
  ]);

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

  const vatRate = Number(settingsResult.data?.vat_rate ?? 23);
  const notas: Fonte<FactoNotaCobranca> = manualResult.error
    ? { ok: false, erro: manualResult.error.message }
    : {
        ok: true,
        factos: (manualResult.data ?? []).map((r) => {
          const base = Number(r.amount);
          const total = cents(base * (r.apply_vat ? 1 + vatRate / 100 : 1));
          const explicit = r.paid_amount == null ? null : Number(r.paid_amount);
          const received = explicit != null
            ? cents(explicit)
            : r.payment_status === "pago_total"
              ? total
              : r.payment_status === "sinal_50"
                ? cents(total / 2)
                : 0;
          return {
            id: r.id,
            clientId: r.client_id,
            chargeDate: r.charge_date,
            total,
            received,
            paidAt: r.paid_at,
          };
        }),
      };

  if (settingsResult.error) return { ok: false, error: settingsResult.error.message };
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
