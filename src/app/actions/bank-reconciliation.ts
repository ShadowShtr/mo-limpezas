"use server";

import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { isValidCashFlowAmount } from "@/lib/cash-flow-integrity";
import { generateSuggestions } from "@/lib/bank-import/reconcile-db";
import { revalidatePath } from "next/cache";

const RECON_PATH = "/dashboard/financeiro/conciliacao";

// ─── Tipos expostos à UI ──────────────────────────────────────────────────────

export interface BankAccountDTO {
  id: string;
  bank_name: string;
  account_name: string;
  iban_last4: string | null;
  currency: string;
  is_active: boolean;
}

export interface SuggestionDTO {
  match_id: string;
  cash_flow_entry_id: string | null;
  match_score: number;
  match_reason: string | null;
  status: "suggested" | "confirmed" | "rejected";
  entry_description: string | null;
  entry_amount: number | null;
  entry_date: string | null;
  entry_type: "entrada" | "saida" | null;
}

export interface BankTransactionDTO {
  id: string;
  transaction_date: string;
  description: string;
  counterparty_name: string | null;
  reference: string | null;
  amount: number;
  direction: "credit" | "debit";
  status: "pending" | "matched" | "reconciled" | "ignored" | "duplicate";
  suggestions: SuggestionDTO[];
}

export interface ImportDTO {
  id: string;
  file_name: string;
  file_type: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

// ─── Contas bancárias ─────────────────────────────────────────────────────────

export async function getBankAccounts(): Promise<{ ok: true; accounts: BankAccountDTO[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const { data, error } = await guard.admin
    .from("bank_accounts")
    .select("id, bank_name, account_name, iban_last4, currency, is_active")
    .eq("company_id", guard.profile.company_id)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, accounts: (data ?? []) as BankAccountDTO[] };
}

export async function createBankAccount(input: {
  bank_name: string;
  account_name: string;
  iban_last4?: string;
  currency?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const bank_name = input.bank_name?.trim();
  const account_name = input.account_name?.trim();
  if (!bank_name || !account_name) return { ok: false, error: "Banco e nome da conta são obrigatórios." };
  const last4 = (input.iban_last4 ?? "").trim();
  if (last4 && !/^\d{4}$/.test(last4)) return { ok: false, error: "IBAN (4 dígitos) inválido." };

  const { error } = await guard.admin.from("bank_accounts").insert({
    company_id: guard.profile.company_id,
    bank_name,
    account_name,
    iban_last4: last4 || null,
    currency: (input.currency ?? "EUR").trim() || "EUR",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(RECON_PATH);
  return { ok: true };
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

export async function getBankReconciliationData(filters?: {
  status?: BankTransactionDTO["status"];
  accountId?: string;
}): Promise<
  | { ok: true; transactions: BankTransactionDTO[]; imports: ImportDTO[]; accounts: BankAccountDTO[] }
  | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  let txQuery = admin
    .from("bank_transactions")
    .select("id, transaction_date, description, counterparty_name, reference, amount, direction, status")
    .eq("company_id", companyId)
    .order("transaction_date", { ascending: false })
    .limit(500);
  if (filters?.status) txQuery = txQuery.eq("status", filters.status);
  if (filters?.accountId) txQuery = txQuery.eq("bank_account_id", filters.accountId);

  const [txRes, impRes, accRes] = await Promise.all([
    txQuery,
    admin
      .from("bank_statement_imports")
      .select("id, file_name, file_type, status, total_rows, imported_rows, duplicate_rows, error_message, created_at, completed_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .from("bank_accounts")
      .select("id, bank_name, account_name, iban_last4, currency, is_active")
      .eq("company_id", companyId)
      .order("created_at", { ascending: true }),
  ]);

  if (txRes.error) return { ok: false, error: txRes.error.message };

  const txs = txRes.data ?? [];
  const txIds = txs.map((t) => t.id);

  // Sugestões + detalhe do lançamento associado
  let suggestionsByTx = new Map<string, SuggestionDTO[]>();
  if (txIds.length > 0) {
    const { data: matches } = await admin
      .from("bank_reconciliation_matches")
      .select("id, bank_transaction_id, cash_flow_entry_id, match_score, match_reason, status, cash_flow_entries(description, amount, date, type)")
      .eq("company_id", companyId)
      .in("bank_transaction_id", txIds)
      .neq("status", "rejected")
      .order("match_score", { ascending: false });

    suggestionsByTx = new Map();
    for (const m of matches ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = (m as any).cash_flow_entries as { description: string; amount: number; date: string; type: "entrada" | "saida" } | null;
      const list = suggestionsByTx.get(m.bank_transaction_id) ?? [];
      list.push({
        match_id: m.id,
        cash_flow_entry_id: m.cash_flow_entry_id,
        match_score: m.match_score,
        match_reason: m.match_reason,
        status: m.status,
        entry_description: entry?.description ?? null,
        entry_amount: entry?.amount ?? null,
        entry_date: entry?.date ?? null,
        entry_type: entry?.type ?? null,
      });
      suggestionsByTx.set(m.bank_transaction_id, list);
    }
  }

  const transactions: BankTransactionDTO[] = txs.map((t) => ({
    id: t.id,
    transaction_date: t.transaction_date,
    description: t.description,
    counterparty_name: t.counterparty_name,
    reference: t.reference,
    amount: t.amount,
    direction: t.direction,
    status: t.status,
    suggestions: suggestionsByTx.get(t.id) ?? [],
  }));

  return {
    ok: true,
    transactions,
    imports: (impRes.data ?? []) as ImportDTO[],
    accounts: (accRes.data ?? []) as BankAccountDTO[],
  };
}

/** Procura lançamentos financeiros para associação manual. */
export async function searchCashFlowEntries(query: string): Promise<
  { ok: true; entries: { id: string; description: string; amount: number; date: string; type: "entrada" | "saida" }[] } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const q = query.trim();

  let dbQuery = guard.admin
    .from("cash_flow_entries")
    .select("id, description, amount, date, type")
    .eq("company_id", guard.profile.company_id)
    .order("date", { ascending: false })
    .limit(20);
  if (q) dbQuery = dbQuery.ilike("description", `%${q}%`);

  const { data, error } = await dbQuery;
  if (error) return { ok: false, error: error.message };
  return { ok: true, entries: (data ?? []) as { id: string; description: string; amount: number; date: string; type: "entrada" | "saida" }[] };
}

// ─── Confirmação manual ───────────────────────────────────────────────────────

export async function confirmMatch(matchId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: match } = await admin
    .from("bank_reconciliation_matches")
    .select("id, bank_transaction_id, cash_flow_entry_id")
    .eq("id", matchId)
    .eq("company_id", companyId)
    .single();
  if (!match) return { ok: false, error: "Sugestão não encontrada." };

  const now = new Date().toISOString();
  const { error: upErr } = await admin
    .from("bank_reconciliation_matches")
    .update({ status: "confirmed", confirmed_by: guard.profile.id, confirmed_at: now })
    .eq("id", matchId)
    .eq("company_id", companyId);
  if (upErr) return { ok: false, error: upErr.message };

  // rejeita as restantes sugestões do mesmo movimento
  await admin
    .from("bank_reconciliation_matches")
    .update({ status: "rejected" })
    .eq("bank_transaction_id", match.bank_transaction_id)
    .eq("company_id", companyId)
    .neq("id", matchId)
    .eq("status", "suggested");

  await admin
    .from("bank_transactions")
    .update({ status: "reconciled", updated_at: now })
    .eq("id", match.bank_transaction_id)
    .eq("company_id", companyId);

  await auditLog({
    companyId, actorId: guard.profile.id, action: "bank_match_confirmed",
    entityType: "bank_reconciliation_match", entityId: matchId,
    meta: { bank_transaction_id: match.bank_transaction_id, cash_flow_entry_id: match.cash_flow_entry_id }, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  return { ok: true };
}

export async function rejectMatch(matchId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: match } = await admin
    .from("bank_reconciliation_matches")
    .select("id, bank_transaction_id")
    .eq("id", matchId)
    .eq("company_id", companyId)
    .single();
  if (!match) return { ok: false, error: "Sugestão não encontrada." };

  const { error } = await admin
    .from("bank_reconciliation_matches")
    .update({ status: "rejected" })
    .eq("id", matchId)
    .eq("company_id", companyId);
  if (error) return { ok: false, error: error.message };

  // se o movimento não tiver mais sugestões ativas, volta a 'pending'
  const { count } = await admin
    .from("bank_reconciliation_matches")
    .select("id", { count: "exact", head: true })
    .eq("bank_transaction_id", match.bank_transaction_id)
    .eq("company_id", companyId)
    .in("status", ["suggested", "confirmed"]);
  if ((count ?? 0) === 0) {
    await admin
      .from("bank_transactions")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", match.bank_transaction_id)
      .eq("company_id", companyId)
      .eq("status", "matched");
  }

  await auditLog({
    companyId, actorId: guard.profile.id, action: "bank_match_rejected",
    entityType: "bank_reconciliation_match", entityId: matchId, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  return { ok: true };
}

export async function manualMatch(bankTransactionId: string, cashFlowEntryId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // valida que ambos pertencem à empresa
  const [{ data: tx }, { data: entry }] = await Promise.all([
    admin.from("bank_transactions").select("id").eq("id", bankTransactionId).eq("company_id", companyId).single(),
    admin.from("cash_flow_entries").select("id").eq("id", cashFlowEntryId).eq("company_id", companyId).single(),
  ]);
  if (!tx) return { ok: false, error: "Movimento não encontrado." };
  if (!entry) return { ok: false, error: "Lançamento não encontrado." };

  const now = new Date().toISOString();
  const { error } = await admin
    .from("bank_reconciliation_matches")
    .upsert(
      {
        company_id: companyId,
        bank_transaction_id: bankTransactionId,
        cash_flow_entry_id: cashFlowEntryId,
        match_score: 100,
        match_reason: "associação manual",
        status: "confirmed",
        confirmed_by: guard.profile.id,
        confirmed_at: now,
      },
      { onConflict: "bank_transaction_id,cash_flow_entry_id" },
    );
  if (error) return { ok: false, error: error.message };

  // rejeita outras sugestões e marca reconciliado
  await admin
    .from("bank_reconciliation_matches")
    .update({ status: "rejected" })
    .eq("bank_transaction_id", bankTransactionId)
    .eq("company_id", companyId)
    .neq("cash_flow_entry_id", cashFlowEntryId)
    .eq("status", "suggested");
  await admin
    .from("bank_transactions")
    .update({ status: "reconciled", updated_at: now })
    .eq("id", bankTransactionId)
    .eq("company_id", companyId);

  await auditLog({
    companyId, actorId: guard.profile.id, action: "bank_match_manual",
    entityType: "bank_transaction", entityId: bankTransactionId,
    meta: { cash_flow_entry_id: cashFlowEntryId }, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  return { ok: true };
}

export async function ignoreTransaction(bankTransactionId: string, ignore = true): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: tx } = await admin
    .from("bank_transactions")
    .select("status")
    .eq("id", bankTransactionId)
    .eq("company_id", companyId)
    .single();
  if (!tx) return { ok: false, error: "Movimento não encontrado." };
  if (tx.status === "reconciled") return { ok: false, error: "Movimento já conciliado." };

  const { error } = await admin
    .from("bank_transactions")
    .update({ status: ignore ? "ignored" : "pending", updated_at: new Date().toISOString() })
    .eq("id", bankTransactionId)
    .eq("company_id", companyId);
  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId, actorId: guard.profile.id, action: ignore ? "bank_tx_ignored" : "bank_tx_unignored",
    entityType: "bank_transaction", entityId: bankTransactionId, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  return { ok: true };
}

/** Cria um lançamento financeiro a partir de um movimento e concilia-os. */
export async function createEntryFromTransaction(bankTransactionId: string, opts?: { category?: string }): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: tx } = await admin
    .from("bank_transactions")
    .select("id, transaction_date, description, amount, direction, status")
    .eq("id", bankTransactionId)
    .eq("company_id", companyId)
    .single();
  if (!tx) return { ok: false, error: "Movimento não encontrado." };
  if (tx.status === "reconciled") return { ok: false, error: "Movimento já conciliado." };
  if (!isValidCashFlowAmount(tx.amount)) return { ok: false, error: "Valor inválido." };

  const category = (opts?.category ?? (tx.direction === "credit" ? "faturacao" : "despesa")) as
    "faturacao" | "salario" | "despesa" | "fornecedor" | "outro";

  const { data: entry, error: entryErr } = await admin
    .from("cash_flow_entries")
    .insert({
      company_id: companyId,
      type: tx.direction === "credit" ? "entrada" : "saida",
      amount: tx.amount,
      description: tx.description || "Movimento bancário",
      category,
      date: tx.transaction_date,
      status: "confirmado",
      notes: "Criado a partir de conciliação bancária",
      created_by: guard.profile.id,
    })
    .select("id")
    .single();
  if (entryErr || !entry) return { ok: false, error: entryErr?.message ?? "Falha ao criar lançamento." };

  const now = new Date().toISOString();
  await admin.from("bank_reconciliation_matches").insert({
    company_id: companyId,
    bank_transaction_id: bankTransactionId,
    cash_flow_entry_id: entry.id,
    match_score: 100,
    match_reason: "lançamento criado a partir do movimento",
    status: "confirmed",
    confirmed_by: guard.profile.id,
    confirmed_at: now,
  });
  await admin
    .from("bank_transactions")
    .update({ status: "reconciled", updated_at: now })
    .eq("id", bankTransactionId)
    .eq("company_id", companyId);

  await auditLog({
    companyId, actorId: guard.profile.id, action: "bank_entry_created",
    entityType: "cash_flow_entry", entityId: entry.id,
    meta: { bank_transaction_id: bankTransactionId }, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  return { ok: true };
}

/**
 * Apaga uma importação e, em cascata, os seus movimentos e sugestões.
 * NÃO apaga lançamentos financeiros (cash_flow_entries) criados a partir dela.
 * Útil para limpar uma importação errada e reimportar.
 */
export async function deleteImport(importId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: imp } = await admin
    .from("bank_statement_imports")
    .select("id, file_name")
    .eq("id", importId)
    .eq("company_id", companyId)
    .single();
  if (!imp) return { ok: false, error: "Importação não encontrada." };

  // bank_transactions e bank_reconciliation_matches têm ON DELETE CASCADE.
  const { error } = await admin
    .from("bank_statement_imports")
    .delete()
    .eq("id", importId)
    .eq("company_id", companyId);
  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId, actorId: guard.profile.id, action: "bank_import_deleted",
    entityType: "bank_statement_import", entityId: importId,
    meta: { file_name: imp.file_name }, source: "dashboard",
  }, admin);

  revalidatePath(RECON_PATH);
  return { ok: true };
}

/** Recalcula sugestões para os movimentos ainda pendentes. */
export async function recalcSuggestions(): Promise<{ ok: boolean; error?: string; created?: number }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: txs } = await admin
    .from("bank_transactions")
    .select("id, transaction_date, amount, direction, description, counterparty_name, reference")
    .eq("company_id", companyId)
    .eq("status", "pending")
    .limit(500);
  if (!txs || txs.length === 0) return { ok: true, created: 0 };

  const created = await generateSuggestions(admin, companyId, txs);
  revalidatePath(RECON_PATH);
  return { ok: true, created };
}
