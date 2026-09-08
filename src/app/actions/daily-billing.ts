"use server";

import { requireProfile } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { auditLog } from "@/lib/audit";
import { readServicePaymentResult } from "@/lib/atomic-rpc-results";

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
  if (error) return { ok: false, error: error.message };

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
