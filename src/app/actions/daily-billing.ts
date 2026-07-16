"use server";

import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { isValidCashFlowAmount } from "@/lib/cash-flow-integrity";
import { todayInLisbon, addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface DailyBillingRow {
  id: string;
  reference_number: string | null;
  scheduled_start: string;
  status: string;
  client_id: string | null;
  client_name: string;
  location_name: string;
  /** Valor do serviço (base, sem IVA). Avenças: fatia mensal ÷ serviços do mês. */
  value: number;
  apply_vat: boolean;
  /** true = pertence a uma avença mensal (valor mostrado é a fatia do mês) */
  is_avenca: boolean;
  payment_status: string; // nao_informado | sinal_50 | pago_total
  paid_amount: number | null;
  paid_at: string | null;
}

export interface DailyBillingData {
  day: DailyBillingRow[];
  /** Serviços de dias ANTERIORES ao dia selecionado ainda não pagos a 100%. */
  pending: DailyBillingRow[];
  vatRate: number;
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

type ServiceRow = {
  id: string;
  reference_number: string | null;
  scheduled_start: string;
  status: string;
  location_id: string;
  contract_id: string | null;
  calculated_value: number | null;
  manual_value: number | null;
  apply_vat: boolean | null;
  payment_status: string | null;
  paid_amount: number | null;
  paid_at: string | null;
};

const SERVICE_COLS =
  "id, reference_number, scheduled_start, status, location_id, contract_id, " +
  "calculated_value, manual_value, apply_vat, payment_status, paid_amount, paid_at";

export async function getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  try {
    return await _getDailyBilling(dateStr);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Erro ao carregar cobrança diária." };
  }
}

async function _getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, error: "Data inválida." };
  }

  // Janela de pendentes: 60 dias antes do dia selecionado.
  const pendingStartStr = addDaysToDateString(dateStr, -60);
  const dayEndExclusive = addDaysToDateString(dateStr, 1);

  const [{ data: dayRows, error: dErr }, { data: pastRows, error: pErr }, { data: settingsRow }] =
    await Promise.all([
      admin
        .from("services")
        .select(SERVICE_COLS)
        .eq("company_id", companyId)
        .gte("scheduled_start", toLisbonTimestamp(dateStr, "00:00"))
        .lt("scheduled_start", toLisbonTimestamp(dayEndExclusive, "00:00"))
        .neq("status", "cancelado")
        .order("scheduled_start"),
      admin
        .from("services")
        .select(SERVICE_COLS)
        .eq("company_id", companyId)
        .gte("scheduled_start", toLisbonTimestamp(pendingStartStr, "00:00"))
        .lt("scheduled_start", toLisbonTimestamp(dateStr, "00:00"))
        .neq("status", "cancelado")
        .neq("payment_status", "pago_total")
        .order("scheduled_start", { ascending: false }),
      admin.from("company_settings").select("vat_rate").eq("company_id", companyId).single(),
    ]);

  if (dErr) return { ok: false, error: dErr.message };
  if (pErr) return { ok: false, error: pErr.message };

  const all = [...(dayRows ?? []), ...(pastRows ?? [])] as unknown as ServiceRow[];

  // Nomes de local/cliente
  const locationIds = [...new Set(all.map((s) => s.location_id).filter(Boolean))];
  const { data: locations } = locationIds.length > 0
    ? await admin.from("locations").select("id, name, client_id, clients(id, name)").in("id", locationIds)
    : { data: [] };
  const locMap = Object.fromEntries(
    (locations ?? []).map((l) => {
      const client = l.clients as unknown as { id: string; name: string } | null;
      return [l.id, { name: l.name as string, clientId: client?.id ?? null, clientName: client?.name ?? "—" }];
    }),
  );

  // Avenças: valor mensal ÷ nº de serviços (não cancelados) do MÊS de cada serviço.
  const contractIds = [...new Set(all.map((s) => s.contract_id).filter(Boolean))] as string[];
  const { data: contracts } = contractIds.length > 0
    ? await admin.from("contracts").select("id, fixed_monthly, fixed_price, apply_vat").in("id", contractIds)
    : { data: [] };
  const contractMap = Object.fromEntries((contracts ?? []).map((c) => [c.id, c]));

  const avencaContractIds = (contracts ?? []).filter((c) => c.fixed_monthly === true).map((c) => c.id);
  // Contagem de serviços por (contrato, mês) para o split da avença — cobre os
  // meses presentes nas linhas carregadas.
  const monthsNeeded = new Set(all.filter((s) => s.contract_id && contractMap[s.contract_id]?.fixed_monthly).map((s) => s.scheduled_start.slice(0, 7)));
  const avencaCount = new Map<string, number>(); // `${contractId}|${YYYY-MM}` → count
  for (const ym of monthsNeeded) {
    if (avencaContractIds.length === 0) break;
    const [y, m] = ym.split("-").map(Number);
    const monthEnd = new Date(y, m, 0).getDate();
    const monthStartStr = `${ym}-01`;
    const nextMonthStartStr = addDaysToDateString(`${ym}-${String(monthEnd).padStart(2, "0")}`, 1);
    const { data: monthRows } = await admin
      .from("services")
      .select("contract_id")
      .eq("company_id", companyId)
      .in("contract_id", avencaContractIds)
      .neq("status", "cancelado")
      .gte("scheduled_start", toLisbonTimestamp(monthStartStr, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(nextMonthStartStr, "00:00"));
    for (const r of monthRows ?? []) {
      const key = `${r.contract_id}|${ym}`;
      avencaCount.set(key, (avencaCount.get(key) ?? 0) + 1);
    }
  }

  function toRow(s: ServiceRow): DailyBillingRow {
    const loc = locMap[s.location_id] ?? { name: "—", clientId: null, clientName: "—" };
    const contract = s.contract_id ? contractMap[s.contract_id] : null;
    const isAvenca = contract?.fixed_monthly === true;
    let value: number;
    let applyVat: boolean;
    if (isAvenca) {
      const ym = s.scheduled_start.slice(0, 7);
      const count = avencaCount.get(`${s.contract_id}|${ym}`) ?? 1;
      value = Math.round(((contract!.fixed_price ?? 0) / Math.max(1, count)) * 100) / 100;
      applyVat = contract!.apply_vat === true;
    } else {
      value = s.manual_value ?? s.calculated_value ?? 0;
      applyVat = s.apply_vat !== false;
    }
    return {
      id: s.id,
      reference_number: s.reference_number,
      scheduled_start: s.scheduled_start,
      status: s.status,
      client_id: loc.clientId,
      client_name: loc.clientName,
      location_name: loc.name,
      value,
      apply_vat: applyVat,
      is_avenca: isAvenca,
      payment_status: s.payment_status ?? "nao_informado",
      paid_amount: s.paid_amount,
      paid_at: s.paid_at,
    };
  }

  const day = ((dayRows ?? []) as unknown as ServiceRow[]).map(toRow);
  // Pendentes: só o que tem valor a cobrar (exclui €0 sem avença).
  const pending = ((pastRows ?? []) as unknown as ServiceRow[]).map(toRow).filter((r) => r.value > 0);

  return {
    ok: true,
    data: { day, pending, vatRate: settingsRow?.vat_rate ?? 23 },
  };
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

export async function setServicePayment(
  serviceId: string,
  status: "nao_informado" | "sinal_50" | "pago_total",
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await _setServicePayment(serviceId, status, paidAmount);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Erro ao registar pagamento." };
  }
}

/**
 * Recalcula o valor base + IVA de UM serviço, replicando a mesma lógica de
 * split de avença usada em getDailyBilling.toRow (mensalidade ÷ nº de
 * serviços do mês). Usado para saber quanto dinheiro foi realmente
 * recebido quando o valor não é indicado explicitamente (botões 50%/100%).
 */
async function computeServiceBillingValue(
  admin: AdminClient,
  companyId: string,
  service: {
    contract_id: string | null;
    manual_value: number | null;
    calculated_value: number | null;
    apply_vat: boolean | null;
    scheduled_start: string;
  },
): Promise<{ baseValue: number; applyVat: boolean }> {
  const fallback = {
    baseValue: service.manual_value ?? service.calculated_value ?? 0,
    applyVat: service.apply_vat !== false,
  };
  if (!service.contract_id) return fallback;

  const { data: contract } = await admin
    .from("contracts")
    .select("fixed_monthly, fixed_price, apply_vat")
    .eq("id", service.contract_id)
    .single();
  if (!contract || contract.fixed_monthly !== true) return fallback;

  const ym = service.scheduled_start.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const monthEnd = new Date(y, m, 0).getDate();
  const nextMonthStartStr = addDaysToDateString(`${ym}-${String(monthEnd).padStart(2, "0")}`, 1);
  const { data: monthRows } = await admin
    .from("services")
    .select("id")
    .eq("company_id", companyId)
    .eq("contract_id", service.contract_id)
    .neq("status", "cancelado")
    .gte("scheduled_start", toLisbonTimestamp(`${ym}-01`, "00:00"))
    .lt("scheduled_start", toLisbonTimestamp(nextMonthStartStr, "00:00"));
  const count = Math.max(1, monthRows?.length ?? 1);

  return {
    baseValue: Math.round(((contract.fixed_price ?? 0) / count) * 100) / 100,
    applyVat: contract.apply_vat === true,
  };
}

/**
 * Espelha o estado de pagamento do serviço em cash_flow_entries
 * (reference_type="service_payment") para que a Cobrança Diária e o
 * Fluxo de Caixa/KPIs financeiros nunca fiquem dessincronizados.
 */
async function syncServicePaymentCashFlow(
  admin: AdminClient,
  companyId: string,
  serviceId: string,
  referenceLabel: string,
  receivedAmount: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (receivedAmount > 0 && isValidCashFlowAmount(receivedAmount)) {
    const { data: existingEntry } = await admin
      .from("cash_flow_entries")
      .select("id")
      .eq("company_id", companyId)
      .eq("reference_type", "service_payment")
      .eq("reference_id", serviceId)
      .maybeSingle();

    if (existingEntry) {
      const { error } = await admin
        .from("cash_flow_entries")
        .update({ amount: receivedAmount, date: todayInLisbon(), status: "confirmado" })
        .eq("id", existingEntry.id);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await admin.from("cash_flow_entries").insert({
        company_id: companyId,
        type: "entrada",
        amount: receivedAmount,
        description: `Cobrança serviço ${referenceLabel}`,
        category: "faturacao",
        date: todayInLisbon(),
        reference_id: serviceId,
        reference_type: "service_payment",
        status: "confirmado",
      });
      if (error) return { ok: false, error: error.message };
    }
  } else {
    const { error } = await admin
      .from("cash_flow_entries")
      .delete()
      .eq("company_id", companyId)
      .eq("reference_type", "service_payment")
      .eq("reference_id", serviceId);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function _setServicePayment(
  serviceId: string,
  status: "nao_informado" | "sinal_50" | "pago_total",
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  if (paidAmount != null && (!Number.isFinite(paidAmount) || paidAmount < 0)) {
    return { ok: false, error: "Valor recebido inválido." };
  }

  const { data: existing } = await admin
    .from("services")
    .select(
      "id, reference_number, payment_status, paid_amount, contract_id, manual_value, calculated_value, apply_vat, scheduled_start",
    )
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .single();
  if (!existing) return { ok: false, error: "Serviço inválido." };

  const { error } = await admin
    .from("services")
    .update({
      payment_status: status,
      paid_amount: paidAmount ?? null,
      paid_at: status === "nao_informado" && paidAmount == null ? null : new Date().toISOString(),
    })
    .eq("id", serviceId)
    .eq("company_id", companyId);
  if (error) return { ok: false, error: error.message };

  // Determina o valor efetivamente recebido para espelhar no Fluxo de Caixa.
  let receivedAmount = 0;
  if (paidAmount != null) {
    receivedAmount = paidAmount;
  } else if (status === "pago_total" || status === "sinal_50") {
    const { data: settingsRow } = await admin
      .from("company_settings")
      .select("vat_rate")
      .eq("company_id", companyId)
      .single();
    const { baseValue, applyVat } = await computeServiceBillingValue(admin, companyId, existing);
    const total = baseValue * (applyVat ? 1 + (settingsRow?.vat_rate ?? 23) / 100 : 1);
    receivedAmount = status === "pago_total" ? total : total / 2;
  }

  const cashFlowResult = await syncServicePaymentCashFlow(
    admin,
    companyId,
    serviceId,
    existing.reference_number ?? serviceId,
    receivedAmount,
  );
  if (!cashFlowResult.ok) return cashFlowResult;

  await auditLog({
    companyId,
    actorId: profile.id,
    action: "billing.payment_status_changed",
    entityType: "service",
    entityId: serviceId,
    meta: {
      from: existing.payment_status,
      to: status,
      paid_amount: paidAmount ?? null,
      cash_flow_amount: receivedAmount,
    },
  }, admin);

  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard/calendario");
  return { ok: true };
}
