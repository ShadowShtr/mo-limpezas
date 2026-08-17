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

import { montarHistoricoCliente, type HistoricoCliente } from "@/domain/finance-v2/client-history";
import type { FactoFatura, Fonte } from "@/domain/finance-v2/aggregate";

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
  const { data, error } = await admin
    .from("invoices")
    .select("id, status, total, due_date, paid_at, period_start, client_id")
    .eq("company_id", companyId)
    .eq("client_id", input.clientId);

  // Sem `data ?? []`: uma query rebentada tem de chegar ao ecrã como erro, não
  // como um ano em que o cliente não pagou nada.
  const faturas: Fonte<FactoFatura> = error
    ? { ok: false, erro: error.message }
    : {
        ok: true,
        factos: (data ?? []).map((r) => ({
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

  return { ok: true, data: montarHistoricoCliente(faturas, input.clientId, input.year) };
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
