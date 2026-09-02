"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { database086Client } from "@/types/database-086";

export type DailyBillingType = "service" | "manual_charge";

export interface DailyBillingRow {
  type: DailyBillingType;
  id: string;
  reference_number: string | null;
  /** Data/hora de apresentação. Para nota de cobrança usa meio-dia civil. */
  scheduled_start: string;
  status: string;
  client_id: string | null;
  client_name: string;
  location_name: string;
  description: string;
  value: number;
  apply_vat: boolean;
  is_avenca: boolean;
  payment_status: string;
  paid_amount: number | null;
  paid_at: string | null;
  notes: string | null;
}

export interface DailyBillingData {
  day: DailyBillingRow[];
  /** Recebíveis anteriores ao dia selecionado ainda não recebidos a 100%. */
  pending: DailyBillingRow[];
  vatRate: number;
}

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
  notes: string | null;
};

type ManualChargeRow = {
  id: string;
  client_id: string;
  charge_date: string;
  description: string;
  amount: number;
  apply_vat: boolean;
  payment_status: string;
  paid_amount: number | null;
  paid_at: string | null;
  notes: string | null;
  voided_at: string | null;
};

const SERVICE_COLS =
  "id, reference_number, scheduled_start, status, location_id, contract_id, " +
  "calculated_value, manual_value, apply_vat, payment_status, paid_amount, paid_at, notes";
const MANUAL_COLS =
  "id, client_id, charge_date, description, amount, apply_vat, payment_status, paid_amount, paid_at, notes, voided_at";

export async function getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  try {
    return await _getDailyBilling(dateStr);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Erro ao carregar cobrança diária." };
  }
}

async function _getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const db086 = database086Client(admin);
  const companyId = profile.company_id;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, error: "Data inválida." };

  const pendingStartStr = addDaysToDateString(dateStr, -60);
  const dayEndExclusive = addDaysToDateString(dateStr, 1);

  const [
    dayServicesResult,
    pastServicesResult,
    dayManualResult,
    pastManualResult,
    settingsResult,
  ] = await Promise.all([
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
      .or("payment_status.is.null,payment_status.neq.pago_total")
      .order("scheduled_start", { ascending: false }),
    db086
      .from("manual_charges")
      .select(MANUAL_COLS)
      .eq("company_id", companyId)
      .eq("charge_date", dateStr)
      .is("voided_at", null)
      .order("created_at"),
    db086
      .from("manual_charges")
      .select(MANUAL_COLS)
      .eq("company_id", companyId)
      .gte("charge_date", pendingStartStr)
      .lt("charge_date", dateStr)
      .neq("payment_status", "pago_total")
      .is("voided_at", null)
      .order("charge_date", { ascending: false }),
    admin.from("company_settings").select("vat_rate").eq("company_id", companyId).single(),
  ]);

  for (const result of [dayServicesResult, pastServicesResult, dayManualResult, pastManualResult]) {
    if (result.error) return { ok: false, error: result.error.message };
  }

  const dayServices = (dayServicesResult.data ?? []) as unknown as ServiceRow[];
  const pastServices = (pastServicesResult.data ?? []) as unknown as ServiceRow[];
  const dayManual = (dayManualResult.data ?? []) as unknown as ManualChargeRow[];
  const pastManual = (pastManualResult.data ?? []) as unknown as ManualChargeRow[];
  const allServices = [...dayServices, ...pastServices];
  const allManual = [...dayManual, ...pastManual];

  const locationIds = [...new Set(allServices.map((service) => service.location_id).filter(Boolean))];
  const locationsResult = locationIds.length > 0
    ? await admin.from("locations").select("id, name, client_id").in("id", locationIds)
    : { data: [], error: null };
  if (locationsResult.error) return { ok: false, error: locationsResult.error.message };

  const manualClientIds = allManual.map((charge) => charge.client_id);
  const locationClientIds = (locationsResult.data ?? []).map((location) => location.client_id).filter(Boolean) as string[];
  const clientIds = [...new Set([...manualClientIds, ...locationClientIds])];
  const clientsResult = clientIds.length > 0
    ? await admin.from("clients").select("id, name").in("id", clientIds).eq("company_id", companyId)
    : { data: [], error: null };
  if (clientsResult.error) return { ok: false, error: clientsResult.error.message };

  const clientMap = Object.fromEntries((clientsResult.data ?? []).map((client) => [client.id, client.name as string]));
  const locMap = Object.fromEntries(
    (locationsResult.data ?? []).map((location) => [location.id, {
      name: location.name as string,
      clientId: location.client_id as string | null,
      clientName: location.client_id ? clientMap[location.client_id] ?? "—" : "—",
    }]),
  );

  const contractIds = [...new Set(allServices.map((service) => service.contract_id).filter(Boolean))] as string[];
  const contractsResult = contractIds.length > 0
    ? await admin.from("contracts").select("id, fixed_monthly, fixed_price, apply_vat").in("id", contractIds)
    : { data: [], error: null };
  if (contractsResult.error) return { ok: false, error: contractsResult.error.message };
  const contractMap = Object.fromEntries((contractsResult.data ?? []).map((contract) => [contract.id, contract]));

  const avencaContractIds = (contractsResult.data ?? [])
    .filter((contract) => contract.fixed_monthly === true)
    .map((contract) => contract.id);
  const monthsNeeded = new Set(
    allServices
      .filter((service) => service.contract_id && contractMap[service.contract_id]?.fixed_monthly)
      .map((service) => service.scheduled_start.slice(0, 7)),
  );
  const avencaCount = new Map<string, number>();
  for (const ym of monthsNeeded) {
    if (avencaContractIds.length === 0) break;
    const [year, month] = ym.split("-").map(Number);
    const monthEnd = new Date(year, month, 0).getDate();
    const nextMonth = addDaysToDateString(`${ym}-${String(monthEnd).padStart(2, "0")}`, 1);
    const { data: rows, error } = await admin
      .from("services")
      .select("contract_id")
      .eq("company_id", companyId)
      .in("contract_id", avencaContractIds)
      .neq("status", "cancelado")
      .gte("scheduled_start", toLisbonTimestamp(`${ym}-01`, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(nextMonth, "00:00"));
    if (error) return { ok: false, error: error.message };
    for (const row of rows ?? []) {
      const key = `${row.contract_id}|${ym}`;
      avencaCount.set(key, (avencaCount.get(key) ?? 0) + 1);
    }
  }

  function serviceToRow(service: ServiceRow): DailyBillingRow {
    const loc = locMap[service.location_id] ?? { name: "—", clientId: null, clientName: "—" };
    const contract = service.contract_id ? contractMap[service.contract_id] : null;
    const isAvenca = contract?.fixed_monthly === true;
    let value = service.manual_value ?? service.calculated_value ?? 0;
    let applyVat = service.apply_vat !== false;
    if (isAvenca) {
      const ym = service.scheduled_start.slice(0, 7);
      const count = avencaCount.get(`${service.contract_id}|${ym}`) ?? 1;
      value = Math.round(((contract!.fixed_price ?? 0) / Math.max(1, count)) * 100) / 100;
      applyVat = contract!.apply_vat === true;
    }
    return {
      type: "service",
      id: service.id,
      reference_number: service.reference_number,
      scheduled_start: service.scheduled_start,
      status: service.status,
      client_id: loc.clientId,
      client_name: loc.clientName,
      location_name: loc.name,
      description: loc.name,
      value,
      apply_vat: applyVat,
      is_avenca: isAvenca,
      payment_status: service.payment_status ?? "nao_informado",
      paid_amount: service.paid_amount,
      paid_at: service.paid_at,
      notes: service.notes,
    };
  }

  function manualToRow(charge: ManualChargeRow): DailyBillingRow {
    return {
      type: "manual_charge",
      id: charge.id,
      reference_number: null,
      scheduled_start: `${charge.charge_date}T12:00:00Z`,
      status: "ativo",
      client_id: charge.client_id,
      client_name: clientMap[charge.client_id] ?? "—",
      location_name: "Nota de cobrança",
      description: charge.description,
      value: Number(charge.amount),
      apply_vat: charge.apply_vat,
      is_avenca: false,
      payment_status: charge.payment_status,
      paid_amount: charge.paid_amount == null ? null : Number(charge.paid_amount),
      paid_at: charge.paid_at,
      notes: charge.notes,
    };
  }

  const day = [...dayServices.map(serviceToRow), ...dayManual.map(manualToRow)]
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start) || a.id.localeCompare(b.id));
  const pending = [...pastServices.map(serviceToRow).filter((row) => row.value > 0), ...pastManual.map(manualToRow)]
    .sort((a, b) => b.scheduled_start.localeCompare(a.scheduled_start) || a.id.localeCompare(b.id));

  return { ok: true, data: { day, pending, vatRate: Number(settingsResult.data?.vat_rate ?? 23) } };
}

export async function setServicePayment(
  serviceId: string,
  status: "nao_informado" | "sinal_50" | "pago_total",
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (paidAmount != null && (!Number.isFinite(paidAmount) || paidAmount < 0)) {
      return { ok: false, error: "Valor recebido inválido." };
    }

    // Writer canónico: estado da origem + cashflow são uma única transação DB.
    const { error } = await admin.rpc("set_service_payment_atomic", {
      p_company_id: profile.company_id,
      p_service_id: serviceId,
      p_status: status,
      p_paid_amount: paidAmount ?? null,
      p_actor: profile.id,
    });
    if (error) return { ok: false, error: error.message };

    revalidatePath("/dashboard/cobrancas");
    revalidatePath("/dashboard/financeiro");
    revalidatePath("/dashboard/calendario");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Erro ao registar pagamento." };
  }
}
