"use server";

// ============================================================================
// Cobranças avulsas — writers
// ============================================================================
//
// 🔴 Cada escrita passa por UMA RPC da 091, e nenhuma escreve em tabelas
//    directamente. É lá — e não aqui — que vivem:
//
//      · o lock do período financeiro, na MESMA transação da escrita (validar o
//        mês aqui e escrever lá abriria a janela CHECK → fecho → WRITE que a
//        090 existe para fechar);
//      · a regra de que o cliente pertence à empresa (o `service_role` passa
//        por cima do RLS, por isso a guarda tem de estar na função);
//      · as três testemunhas de «tem dinheiro» (estado, valor, caixa);
//      · o par cobrança + movimento de caixa do recebimento.
//
//    Não há `assertFinancialPeriodOpen` antes da chamada: seria um segundo
//    sítio a decidir o mesmo, fora da transação que o garante.
//
// Criar uma cobrança NÃO cria serviço, `invoice_item`, fatura nem movimento de
// caixa. O caixa só nasce no recebimento.
// ============================================================================

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { isValidIsoDateString } from "@/lib/utils";
import { readManualChargePaymentResult, readManualChargeResult } from "@/lib/atomic-rpc-results";
import { BILLING_GENERIC_FAILURE, interpretBillingRefusal } from "@/domain/billing/billing-errors";
import type { BillingPaymentStatus } from "@/domain/billing/daily-billing";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ManualChargeInput {
  clientId: string;
  chargeDate: string;
  description: string;
  amount: number;
  applyVat: boolean;
  notes?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DESCRIPTION = 500;
const MAX_NOTES = 2000;

function revalidateBillingSurfaces(clientId?: string | null) {
  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
  if (clientId) revalidatePath(`/dashboard/clientes/${clientId}`);
}

function rpcFailure(contexto: string, error: { message: string; code?: string }): { ok: false; error: string } {
  const recusa = interpretBillingRefusal(error.message);
  if (recusa) return { ok: false, error: recusa.message };
  console.error(`[${contexto}] RPC falhou`, { code: error.code ?? null, message: error.message });
  return { ok: false, error: BILLING_GENERIC_FAILURE };
}

function unexpected(contexto: string, e: unknown): { ok: false; error: string } {
  console.error(`[${contexto}] falhou`, e instanceof Error ? e.message : e);
  return { ok: false, error: BILLING_GENERIC_FAILURE };
}

function validateAmount(amount: unknown): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return "O valor deve ser superior a zero.";
  }
  if (Math.round(amount * 100) / 100 !== amount) return "O valor só pode ter até duas casas decimais.";
  if (amount >= 100_000_000) return "O valor é demasiado alto.";
  return null;
}

// ─── Criar ───────────────────────────────────────────────────────────────────

export async function createManualCharge(input: ManualChargeInput): Promise<Result<{ id: string }>> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (!UUID.test(input.clientId ?? "")) return { ok: false, error: "Escolha um cliente." };
    if (!isValidIsoDateString(input.chargeDate)) return { ok: false, error: "Data inválida." };
    const description = (input.description ?? "").trim();
    if (!description) return { ok: false, error: "A descrição é obrigatória." };
    if (description.length > MAX_DESCRIPTION) return { ok: false, error: "A descrição é demasiado longa." };
    const amountError = validateAmount(input.amount);
    if (amountError) return { ok: false, error: amountError };
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > MAX_NOTES) return { ok: false, error: "As notas são demasiado longas." };

    const { data, error } = await admin.rpc("create_manual_charge_atomic", {
      p_company_id: profile.company_id,
      p_client_id: input.clientId,
      p_charge_date: input.chargeDate,
      p_description: description,
      p_amount: input.amount,
      p_apply_vat: input.applyVat === true,
      p_notes: notes,
      p_actor: profile.id,
    });
    if (error) return rpcFailure("createManualCharge", error);

    // Uma resposta com outra forma não é sucesso: não se sabe o que ficou.
    const criada = readManualChargeResult(data);
    if (!criada.ok) return criada;
    const id = criada.chargeId;

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "billing.manual_charge_created",
      entityType: "manual_charge",
      entityId: id,
      meta: { client_id: input.clientId, charge_date: input.chargeDate, amount: input.amount, apply_vat: input.applyVat === true },
    }, admin);

    revalidateBillingSurfaces(input.clientId);
    return { ok: true, id };
  } catch (e) {
    return unexpected("createManualCharge", e);
  }
}

// ─── Editar ──────────────────────────────────────────────────────────────────

export type ManualChargePatch = Partial<ManualChargeInput>;

export async function updateManualCharge(chargeId: string, patch: ManualChargePatch): Promise<Result> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (!UUID.test(chargeId ?? "")) return { ok: false, error: "Cobrança inválida." };

    // Só as chaves que a 091 aceita. O resto nem chega à base.
    const rpcPatch: Record<string, unknown> = {};
    if (patch.clientId !== undefined) {
      if (!UUID.test(patch.clientId)) return { ok: false, error: "Escolha um cliente." };
      rpcPatch.client_id = patch.clientId;
    }
    if (patch.chargeDate !== undefined) {
      if (!isValidIsoDateString(patch.chargeDate)) return { ok: false, error: "Data inválida." };
      rpcPatch.charge_date = patch.chargeDate;
    }
    if (patch.description !== undefined) {
      const d = patch.description.trim();
      if (!d) return { ok: false, error: "A descrição é obrigatória." };
      if (d.length > MAX_DESCRIPTION) return { ok: false, error: "A descrição é demasiado longa." };
      rpcPatch.description = d;
    }
    if (patch.amount !== undefined) {
      const amountError = validateAmount(patch.amount);
      if (amountError) return { ok: false, error: amountError };
      rpcPatch.amount = patch.amount;
    }
    if (patch.applyVat !== undefined) rpcPatch.apply_vat = patch.applyVat === true;
    if (patch.notes !== undefined) {
      const n = patch.notes?.trim() || null;
      if (n && n.length > MAX_NOTES) return { ok: false, error: "As notas são demasiado longas." };
      rpcPatch.notes = n;
    }

    if (Object.keys(rpcPatch).length === 0) return { ok: true };

    const { data, error } = await admin.rpc("update_manual_charge_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_patch: rpcPatch,
      p_actor: profile.id,
    });
    if (error) return rpcFailure("updateManualCharge", error);
    const confirmada = readManualChargeResult(data, chargeId);
    if (!confirmada.ok) return confirmada;

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "billing.manual_charge_updated",
      entityType: "manual_charge",
      entityId: chargeId,
      meta: { fields: Object.keys(rpcPatch) },
    }, admin);

    revalidateBillingSurfaces(patch.clientId);
    return { ok: true };
  } catch (e) {
    return unexpected("updateManualCharge", e);
  }
}

// ─── Recebimento ─────────────────────────────────────────────────────────────

export async function setManualChargePayment(
  chargeId: string,
  status: BillingPaymentStatus,
  paidAmount?: number | null,
): Promise<Result<{ cashAmount: number }>> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (!UUID.test(chargeId ?? "")) return { ok: false, error: "Cobrança inválida." };
    if (!["nao_informado", "sinal_50", "pago_total"].includes(status)) {
      return { ok: false, error: "Estado de recebimento inválido." };
    }
    if (paidAmount != null && (!Number.isFinite(paidAmount) || paidAmount < 0)) {
      return { ok: false, error: "Valor recebido inválido." };
    }

    const { data, error } = await admin.rpc("set_manual_charge_payment_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_status: status,
      p_paid_amount: paidAmount ?? null,
      p_actor: profile.id,
    });
    if (error) return rpcFailure("setManualChargePayment", error);

    // `cash_amount` é a autoridade sobre quanto entrou em caixa — não se
    // recalcula deste lado.
    const confirmacao = readManualChargePaymentResult(data, chargeId);
    if (!confirmacao.ok) return confirmacao;
    const cashAmount = confirmacao.cashAmount;

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "billing.manual_charge_payment_changed",
      entityType: "manual_charge",
      entityId: chargeId,
      meta: { to: status, paid_amount: paidAmount ?? null, cash_flow_amount: cashAmount },
    }, admin);

    revalidateBillingSurfaces();
    return { ok: true, cashAmount };
  } catch (e) {
    return unexpected("setManualChargePayment", e);
  }
}

// ─── Excluir (= anular) ──────────────────────────────────────────────────────
//
// «Excluir» no ecrã é ANULAR na base: a linha fica, com `voided_at`, e sai de
// todas as somas. Apagar destruiria a prova de que a cobrança existiu. Com
// recebimento registado, a 091 recusa — é preciso retirar o recebimento
// primeiro, o que passa pelo caixa com o período trancado.

export async function voidManualCharge(chargeId: string): Promise<Result> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { admin, profile } = guard;

    if (!UUID.test(chargeId ?? "")) return { ok: false, error: "Cobrança inválida." };

    const { data, error } = await admin.rpc("void_manual_charge_atomic", {
      p_company_id: profile.company_id,
      p_charge_id: chargeId,
      p_actor: profile.id,
    });
    if (error) return rpcFailure("voidManualCharge", error);
    const anulada = readManualChargeResult(data, chargeId);
    if (!anulada.ok) return anulada;

    await auditLog({
      companyId: profile.company_id,
      actorId: profile.id,
      action: "billing.manual_charge_voided",
      entityType: "manual_charge",
      entityId: chargeId,
      meta: {},
    }, admin);

    revalidateBillingSurfaces();
    return { ok: true };
  } catch (e) {
    return unexpected("voidManualCharge", e);
  }
}
