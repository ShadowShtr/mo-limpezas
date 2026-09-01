"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import { database086Client } from "@/types/database-086";

export type ManualChargePaymentStatus = "nao_informado" | "sinal_50" | "pago_total";

export interface ManualChargeInput {
  clientId: string;
  chargeDate: string;
  description: string;
  amount: number;
  applyVat: boolean;
  notes?: string | null;
}

function revalidateFinancialSurfaces(clientId?: string) {
  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
  if (clientId) revalidatePath(`/dashboard/clientes/${clientId}`);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

export async function createManualCharge(
  input: ManualChargeInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;
    const db = database086Client(admin);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.chargeDate)) {
      return { ok: false, error: "Data inválida." };
    }
    if (!input.description.trim()) {
      return { ok: false, error: "Descrição obrigatória." };
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { ok: false, error: "O valor deve ser superior a zero." };
    }

    const { data: client, error: clientError } = await admin
      .from("clients")
      .select("id")
      .eq("id", input.clientId)
      .eq("company_id", profile.company_id)
      .maybeSingle();
    if (clientError) return { ok: false, error: clientError.message };
    if (!client) return { ok: false, error: "Cliente inválido." };

    // Criar a obrigação NÃO cria serviço, invoice_item nem movimento de caixa.
    // O caixa só nasce quando o recebimento passa pelo RPC atómico.
    const { data, error } = await db
      .from("manual_charges")
      .insert({
        company_id: profile.company_id,
        client_id: input.clientId,
        charge_date: input.chargeDate,
        description: input.description.trim(),
        amount: input.amount,
        apply_vat: input.applyVat,
        notes: input.notes?.trim() || null,
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Não foi possível criar a cobrança." };

    revalidateFinancialSurfaces(input.clientId);
    return { ok: true, id: data.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Erro ao criar cobrança avulsa.") };
  }
}

export async function updateManualCharge(
  chargeId: string,
  patch: Partial<Pick<ManualChargeInput, "clientId" | "chargeDate" | "description" | "amount" | "applyVat" | "notes">>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    const rpcPatch: Record<string, unknown> = {};
    if ("clientId" in patch) rpcPatch.client_id = patch.clientId;
    if ("chargeDate" in patch) rpcPatch.charge_date = patch.chargeDate;
    if ("description" in patch) rpcPatch.description = patch.description?.trim();
    if ("amount" in patch) rpcPatch.amount = patch.amount;
    if ("applyVat" in patch) rpcPatch.apply_vat = patch.applyVat;
    if ("notes" in patch) rpcPatch.notes = patch.notes?.trim() || null;

    if (Object.keys(rpcPatch).length === 0) return { ok: true };

    const { error } = await admin.rpc("update_manual_charge_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_patch: rpcPatch,
      p_actor: profile.id,
    });
    if (error) return { ok: false, error: error.message };

    revalidateFinancialSurfaces(patch.clientId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Erro ao atualizar cobrança avulsa.") };
  }
}

export async function setManualChargePayment(
  chargeId: string,
  status: ManualChargePaymentStatus,
  paidAmount?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (paidAmount != null && (!Number.isFinite(paidAmount) || paidAmount < 0)) {
      return { ok: false, error: "Valor recebido inválido." };
    }

    const { error } = await admin.rpc("set_manual_charge_payment_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_status: status,
      p_paid_amount: paidAmount ?? null,
      p_actor: profile.id,
    });
    if (error) return { ok: false, error: error.message };

    revalidateFinancialSurfaces();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Erro ao registar recebimento da cobrança.") };
  }
}

export async function voidManualCharge(
  chargeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    const { error } = await admin.rpc("void_manual_charge_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_actor: profile.id,
    });
    if (error) return { ok: false, error: error.message };

    revalidateFinancialSurfaces();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Erro ao anular cobrança avulsa.") };
  }
}

export async function deleteBillingService(
  serviceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    const { error } = await admin.rpc("delete_calendar_service_safe", {
      p_service_id: serviceId,
      p_scope: "single",
      p_company_id: profile.company_id,
      p_actor: profile.id,
    });
    if (error) return { ok: false, error: error.message };

    revalidatePath("/dashboard/cobrancas");
    revalidatePath("/dashboard/calendario");
    revalidatePath("/dashboard/financeiro");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Erro ao eliminar serviço.") };
  }
}
