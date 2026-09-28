"use server";

import { requireProfile } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { auditLog } from "@/lib/audit";
import { readServicePaymentResult } from "@/lib/atomic-rpc-results";
import { queryFailure } from "@/lib/query-error";
import { isValidIsoDateString } from "@/lib/utils";
import { BILLING_GENERIC_FAILURE, interpretBillingRefusal } from "@/domain/billing/billing-errors";
import {
  billingRowCivilDate,
  isPendingReceivable,
  type BillingPaymentStatus,
  type DailyBillingRow,
  type ManualChargeBillingRow,
  type ServiceBillingRow,
} from "@/domain/billing/daily-billing";

// ─── Tipos ────────────────────────────────────────────────────────────────────
//
// A forma de uma linha vive no domínio (`@/domain/billing/daily-billing`): é
// uma união discriminada serviço / cobrança avulsa, e é lá que estão as regras
// de valor, recebido e pendente. Aqui só se lê e se converte.

export type {
  DailyBillingRow,
  ServiceBillingRow,
  ManualChargeBillingRow,
  BillingPaymentStatus,
} from "@/domain/billing/daily-billing";

export interface DailyBillingData {
  day: DailyBillingRow[];
  /** Recebíveis de dias ANTERIORES ao dia selecionado ainda não pagos a 100%. */
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
  notes: string | null;
};

type ManualChargeRow = {
  id: string;
  client_id: string;
  charge_date: string;
  description: string;
  amount: number | string;
  apply_vat: boolean;
  payment_status: string;
  paid_amount: number | string | null;
  paid_at: string | null;
  notes: string | null;
};

type LocationRow = { id: string; name: string; client_id: string | null };
type ContractRow = { id: string; fixed_monthly: boolean | null; fixed_price: number | null; apply_vat: boolean | null };

const SERVICE_COLS =
  "id, reference_number, scheduled_start, status, location_id, contract_id, " +
  "calculated_value, manual_value, apply_vat, payment_status, paid_amount, paid_at, notes";

const MANUAL_COLS =
  "id, client_id, charge_date, description, amount, apply_vat, payment_status, paid_amount, paid_at, notes";

/** Janela dos pendentes: 60 dias antes do dia selecionado, para os dois tipos. */
const PENDING_WINDOW_DAYS = 60;

function asStatus(v: string | null | undefined): BillingPaymentStatus {
  return v === "sinal_50" || v === "pago_total" ? v : "nao_informado";
}

function asNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  try {
    return await _getDailyBilling(dateStr);
  } catch (e) {
    console.error("[getDailyBilling] falhou", e instanceof Error ? e.message : e);
    return { ok: false, error: "Erro ao carregar cobrança diária." };
  }
}

async function _getDailyBilling(
  dateStr: string,
): Promise<{ ok: true; data: DailyBillingData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  if (!isValidIsoDateString(dateStr)) {
    return { ok: false, error: "Data inválida." };
  }

  const pendingStartStr = addDaysToDateString(dateStr, -PENDING_WINDOW_DAYS);
  const dayEndExclusive = addDaysToDateString(dateStr, 1);

  // Quatro leituras independentes, em paralelo: serviços e cobranças avulsas,
  // do dia e dos dias anteriores. A cobrança avulsa tem data CIVIL, por isso
  // filtra-se por `charge_date` e não por intervalo de instantes.
  const [dayServices, pastServices, dayManual, pastManual, settings] = await Promise.all([
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
      // 🔴 `neq` sozinho deixava de fora `payment_status IS NULL`: em SQL,
      //    `NULL <> 'pago_total'` não é verdadeiro. Um serviço antigo sem
      //    estado gravado é, precisamente, um serviço por cobrar.
      .or("payment_status.is.null,payment_status.neq.pago_total")
      .order("scheduled_start", { ascending: false }),
    admin
      .from("manual_charges")
      .select(MANUAL_COLS)
      .eq("company_id", companyId)
      .eq("charge_date", dateStr)
      // Anulada não é recebível: sai do dia, dos pendentes e dos totais.
      .is("voided_at", null)
      .order("created_at"),
    admin
      .from("manual_charges")
      .select(MANUAL_COLS)
      .eq("company_id", companyId)
      .gte("charge_date", pendingStartStr)
      .lt("charge_date", dateStr)
      .neq("payment_status", "pago_total")
      .is("voided_at", null)
      .order("charge_date", { ascending: false }),
    admin.from("company_settings").select("vat_rate").eq("company_id", companyId).maybeSingle(),
  ]);

  // Uma leitura falhada não é um dia sem cobranças.
  const leituras = [
    ["services:day", dayServices.error],
    ["services:pending", pastServices.error],
    ["manual_charges:day", dayManual.error],
    ["manual_charges:pending", pastManual.error],
    ["company_settings", settings.error],
  ] as const;
  for (const [ctx, error] of leituras) {
    if (error) return queryFailure(`getDailyBilling:${ctx}`, error);
  }

  const servicesDay = (dayServices.data ?? []) as unknown as ServiceRow[];
  const servicesPast = (pastServices.data ?? []) as unknown as ServiceRow[];
  const manualDay = (dayManual.data ?? []) as unknown as ManualChargeRow[];
  const manualPast = (pastManual.data ?? []) as unknown as ManualChargeRow[];
  const allServices = [...servicesDay, ...servicesPast];
  const allManual = [...manualDay, ...manualPast];

  // Local → cliente, para os serviços.
  const locationIds = [...new Set(allServices.map((s) => s.location_id).filter(Boolean))];
  let locations: LocationRow[] = [];
  if (locationIds.length > 0) {
    const { data, error } = await admin
      .from("locations").select("id, name, client_id").eq("company_id", companyId).in("id", locationIds);
    if (error) return queryFailure("getDailyBilling:locations", error);
    locations = (data ?? []) as unknown as LocationRow[];
  }

  // Nomes de cliente: os dos locais E os das cobranças avulsas, numa leitura.
  const clientIds = [...new Set([
    ...locations.map((l) => l.client_id).filter((v): v is string => !!v),
    ...allManual.map((c) => c.client_id),
  ])];
  const clientName = new Map<string, string>();
  if (clientIds.length > 0) {
    const { data, error } = await admin
      .from("clients").select("id, name").eq("company_id", companyId).in("id", clientIds);
    if (error) return queryFailure("getDailyBilling:clients", error);
    for (const c of data ?? []) clientName.set(c.id as string, c.name as string);
  }

  const locMap = new Map(locations.map((l) => [l.id, {
    name: l.name,
    clientId: l.client_id,
    clientName: l.client_id ? clientName.get(l.client_id) ?? "—" : "—",
  }]));

  // Avenças: valor mensal ÷ nº de serviços (não cancelados) do MÊS de cada serviço.
  const contractIds = [...new Set(allServices.map((s) => s.contract_id).filter(Boolean))] as string[];
  let contracts: ContractRow[] = [];
  if (contractIds.length > 0) {
    const { data, error } = await admin
      .from("contracts").select("id, fixed_monthly, fixed_price, apply_vat").eq("company_id", companyId).in("id", contractIds);
    if (error) return queryFailure("getDailyBilling:contracts", error);
    contracts = (data ?? []) as unknown as ContractRow[];
  }
  const contractMap = new Map(contracts.map((c) => [c.id, c]));

  const avencaContractIds = contracts.filter((c) => c.fixed_monthly === true).map((c) => c.id);
  const monthsNeeded = new Set(
    allServices
      .filter((s) => s.contract_id && contractMap.get(s.contract_id)?.fixed_monthly)
      .map((s) => s.scheduled_start.slice(0, 7)),
  );
  const avencaCount = new Map<string, number>(); // `${contractId}|${YYYY-MM}` → count
  for (const ym of monthsNeeded) {
    if (avencaContractIds.length === 0) break;
    const [y, m] = ym.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const nextMonthStartStr = addDaysToDateString(`${ym}-${String(monthEnd).padStart(2, "0")}`, 1);
    const { data: monthRows, error: monthErr } = await admin
      .from("services")
      .select("contract_id")
      .eq("company_id", companyId)
      .in("contract_id", avencaContractIds)
      .neq("status", "cancelado")
      .gte("scheduled_start", toLisbonTimestamp(`${ym}-01`, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(nextMonthStartStr, "00:00"));
    // Sem contagem, a fatia da avença seria o valor mensal inteiro num dia só.
    if (monthErr) return queryFailure("getDailyBilling:avenca-count", monthErr);
    for (const r of monthRows ?? []) {
      const key = `${r.contract_id}|${ym}`;
      avencaCount.set(key, (avencaCount.get(key) ?? 0) + 1);
    }
  }

  function serviceToRow(s: ServiceRow): ServiceBillingRow {
    const loc = locMap.get(s.location_id) ?? { name: "—", clientId: null, clientName: "—" };
    const contract = s.contract_id ? contractMap.get(s.contract_id) : undefined;
    const isAvenca = contract?.fixed_monthly === true;
    let value: number;
    let applyVat: boolean;
    if (isAvenca && contract) {
      const ym = s.scheduled_start.slice(0, 7);
      const count = avencaCount.get(`${s.contract_id}|${ym}`) ?? 1;
      value = Math.round(((contract.fixed_price ?? 0) / Math.max(1, count)) * 100) / 100;
      applyVat = contract.apply_vat === true;
    } else {
      value = s.manual_value ?? s.calculated_value ?? 0;
      applyVat = s.apply_vat !== false;
    }
    return {
      type: "service",
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
      payment_status: asStatus(s.payment_status),
      paid_amount: asNumber(s.paid_amount),
      paid_at: s.paid_at,
      notes: s.notes,
    };
  }

  function manualToRow(c: ManualChargeRow): ManualChargeBillingRow {
    return {
      type: "manual_charge",
      id: c.id,
      charge_date: c.charge_date,
      description: c.description,
      client_id: c.client_id,
      client_name: clientName.get(c.client_id) ?? "—",
      value: asNumber(c.amount) ?? 0,
      apply_vat: c.apply_vat,
      payment_status: asStatus(c.payment_status),
      paid_amount: asNumber(c.paid_amount),
      paid_at: c.paid_at,
      notes: c.notes,
    };
  }

  const vatRate = Number(settings.data?.vat_rate ?? 23);
  const day: DailyBillingRow[] = [...servicesDay.map(serviceToRow), ...manualDay.map(manualToRow)];
  // Pendentes: a MESMA regra para os dois tipos, no domínio.
  const pending: DailyBillingRow[] = [...servicesPast.map(serviceToRow), ...manualPast.map(manualToRow)]
    .filter((r) => isPendingReceivable(r, vatRate))
    .sort((a, b) => billingRowCivilDate(b).localeCompare(billingRowCivilDate(a)));

  return { ok: true, data: { day, pending, vatRate } };
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
    console.error("[setServicePayment] falhou", e instanceof Error ? e.message : e);
    return { ok: false, error: "Erro ao registar pagamento." };
  }
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

  // O estado ANTERIOR tem de ser lido antes da RPC: depois dela já não existe,
  // e sem ele a auditoria não diz de onde é que o pagamento veio.
  const { data: antes, error: antesErr } = await admin
    .from("services")
    .select("payment_status")
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .maybeSingle();
  // Uma leitura falhada e um serviço inexistente não são a mesma coisa:
  // engolir o erro daria "Serviço inválido." a quem tem o serviço à frente.
  if (antesErr) {
    return { ok: false, error: "Não foi possível confirmar o estado atual do serviço. Atualize a página e tente novamente." };
  }
  if (!antes) return { ok: false, error: "Serviço inválido." };

  const { data: linhas, error } = await admin.rpc("set_service_payment_atomic", {
    p_company_id: companyId,
    p_service_id: serviceId,
    p_status: status,
    p_paid_amount: paidAmount ?? null,
    p_actor: profile.id,
  });
  if (error) {
    // Período fechado, serviço inexistente, estado incoerente: recusas da base
    // com código estável. O resto é falha técnica — detalhe no log, frase
    // genérica no ecrã.
    const recusa = interpretBillingRefusal(error.message);
    if (recusa) return { ok: false, error: recusa.message };
    console.error("[setServicePayment] RPC falhou", { code: error.code ?? null, message: error.message });
    return { ok: false, error: BILLING_GENERIC_FAILURE };
  }

  // A RPC é a autoridade económica: o valor que entrou em caixa é o que ELA
  // gravou, não um número recalculado aqui. Recalcular em TypeScript era
  // exatamente a segunda fonte da mesma regra que a 097 veio fechar — e a
  // auditoria passaria a registar um valor que a base pode não ter.
  const confirmacao = readServicePaymentResult(linhas, serviceId);
  if (!confirmacao.ok) return confirmacao;

  await auditLog({
    companyId,
    actorId: profile.id,
    action: "billing.payment_status_changed",
    entityType: "service",
    entityId: serviceId,
    meta: {
      from: antes.payment_status,
      to: status,
      paid_amount: paidAmount ?? null,
      cash_flow_amount: confirmacao.cashAmount,
    },
  }, admin);

  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard/calendario");
  return { ok: true };
}
