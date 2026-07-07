// Geração de sugestões de conciliação contra a BD.
// Partilhado pelo endpoint de importação e pela ação de "recalcular sugestões".
// Usa o admin client (já validado a montante) — NÃO faz verificação de permissões.

import type { createAdminClient } from "@/lib/supabase/admin";
import { suggestMatches, type CashEntryLike } from "./matching";
import { detectDatabaseDuplicates } from "./fingerprint";
import type { ParsedTransaction } from "./preview";
import { auditLog } from "@/lib/audit";

type AdminClient = ReturnType<typeof createAdminClient>;

interface TxRow {
  id: string;
  transaction_date: string;
  amount: number;
  direction: "credit" | "debit";
  description: string;
  counterparty_name: string | null;
  reference: string | null;
}

/**
 * Para cada movimento, procura lançamentos financeiros semelhantes e grava
 * sugestões em bank_reconciliation_matches (status 'suggested'). Marca o
 * movimento como 'matched' se houver pelo menos uma sugestão.
 * NÃO confirma nada automaticamente.
 *
 * Devolve o nº de sugestões criadas.
 */
export async function generateSuggestions(
  admin: AdminClient,
  companyId: string,
  txs: TxRow[],
): Promise<number> {
  if (txs.length === 0) return 0;

  // Janela de datas para limitar os candidatos
  const dates = txs.map((t) => t.transaction_date).sort();
  const minDate = shiftDays(dates[0], -10);
  const maxDate = shiftDays(dates[dates.length - 1], 10);

  const { data: entriesRaw } = await admin
    .from("cash_flow_entries")
    .select("id, type, amount, description, date, reference_id, reference_type")
    .eq("company_id", companyId)
    .gte("date", minDate)
    .lte("date", maxDate);

  const entries: CashEntryLike[] = (entriesRaw ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    amount: e.amount,
    description: e.description,
    date: e.date,
    counterparty_name: null,
    reference: null,
  }));

  if (entries.length === 0) return 0;

  // Lançamentos já confirmados noutra conciliação não devem ser sugeridos de novo
  const { data: confirmed } = await admin
    .from("bank_reconciliation_matches")
    .select("cash_flow_entry_id")
    .eq("company_id", companyId)
    .eq("status", "confirmed");
  const usedEntryIds = new Set((confirmed ?? []).map((c) => c.cash_flow_entry_id).filter(Boolean));
  const available = entries.filter((e) => !usedEntryIds.has(e.id));

  let created = 0;
  const matchedTxIds: string[] = [];

  for (const tx of txs) {
    const suggestions = suggestMatches(tx, available, { minScore: 50, maxSuggestions: 3 });
    if (suggestions.length === 0) continue;

    const rows = suggestions.map((s) => ({
      company_id: companyId,
      bank_transaction_id: tx.id,
      cash_flow_entry_id: s.entryId,
      match_score: s.score,
      match_reason: s.reason,
      status: "suggested" as const,
    }));

    const { error } = await admin
      .from("bank_reconciliation_matches")
      .upsert(rows, { onConflict: "bank_transaction_id,cash_flow_entry_id", ignoreDuplicates: true });
    if (!error) {
      created += rows.length;
      matchedTxIds.push(tx.id);
    }
  }

  if (matchedTxIds.length > 0) {
    await admin
      .from("bank_transactions")
      .update({ status: "matched", updated_at: new Date().toISOString() })
      .in("id", matchedTxIds)
      .eq("company_id", companyId)
      .eq("status", "pending"); // não rebaixa movimentos já reconciliados/ignorados
  }

  return created;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fingerprints já gravados para a empresa+conta — usado para detetar duplicados já existentes. */
export async function fetchExistingFingerprints(
  admin: AdminClient,
  companyId: string,
  bankAccountId: string | null,
): Promise<Set<string>> {
  let q = admin.from("bank_transactions").select("fingerprint").eq("company_id", companyId);
  q = bankAccountId ? q.eq("bank_account_id", bankAccountId) : q.is("bank_account_id", null);
  const { data } = await q;
  return new Set((data ?? []).map((r) => r.fingerprint));
}

export interface ConfirmImportParams {
  companyId: string;
  bankAccountId: string | null;
  fileName: string;
  fileHash: string;
  userId: string;
  transactions: ParsedTransaction[]; // já filtradas (válidas, sem duplicados) pelo preview
  totalRows: number;
}

export type ConfirmImportResult =
  | { ok: true; importId: string; imported: number; duplicates: number; suggestions: number }
  | { ok: false; error: string; status: number };

/**
 * Grava a importação confirmada pelo utilizador: cria o registo de
 * importação, insere os movimentos (deduplicando de novo contra a BD, para
 * cobrir corridas concorrentes entre o preview e o commit), gera sugestões
 * de conciliação só para os não-duplicados, e audita.
 */
export async function confirmBankStatementImport(
  admin: AdminClient,
  params: ConfirmImportParams,
): Promise<ConfirmImportResult> {
  const { companyId, bankAccountId, fileName, fileHash, userId, transactions, totalRows } = params;

  const { data: existingImport } = await admin
    .from("bank_statement_imports")
    .select("id")
    .eq("company_id", companyId)
    .eq("file_hash", fileHash)
    .maybeSingle();
  if (existingImport) {
    return { ok: false, error: "Este ficheiro já foi importado anteriormente.", status: 409 };
  }

  const { data: imp, error: impErr } = await admin
    .from("bank_statement_imports")
    .insert({
      company_id: companyId,
      bank_account_id: bankAccountId,
      file_name: fileName,
      file_type: "csv",
      file_hash: fileHash,
      status: "processing",
      total_rows: totalRows,
      uploaded_by: userId,
    })
    .select("id")
    .single();
  if (impErr || !imp) {
    return { ok: false, error: "Falha a registar importação.", status: 500 };
  }

  try {
    const existingFingerprints = await fetchExistingFingerprints(admin, companyId, bankAccountId);
    const nowDuplicate = detectDatabaseDuplicates(transactions.map((t) => t.fingerprint), existingFingerprints);

    // Duplicados contra a BD não podem ser inseridos (o unique index nunca os
    // deixaria persistir — daria conflito com a linha já existente). Calcular
    // a contagem ANTES do insert e só tentar gravar os movimentos realmente
    // novos evita depender do que o upsert(ignoreDuplicates) devolve, que
    // omite silenciosamente as linhas em conflito.
    const duplicateRows = nowDuplicate.size;
    const toInsert = transactions
      .filter((t) => !nowDuplicate.has(t.fingerprint))
      .map((t) => ({
        company_id: companyId,
        bank_account_id: bankAccountId,
        statement_import_id: imp.id,
        transaction_date: t.transaction_date,
        value_date: t.value_date,
        description: t.description,
        counterparty_name: t.counterparty_name,
        reference: t.reference,
        amount: t.amount,
        direction: t.direction,
        currency: t.currency,
        raw_data: t.raw_data,
        fingerprint: t.fingerprint,
        source_row_index: t.index,
        status: "pending" as const,
      }));

    const inserted: { id: string; transaction_date: string; amount: number; direction: "credit" | "debit"; description: string; counterparty_name: string | null; reference: string | null; status: string }[] = [];
    const BATCH = 200;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const slice = toInsert.slice(i, i + BATCH);
      // onConflict usa bank_account_key (coluna gerada, NULL-safe) em vez de
      // bank_account_id — ver migration 050. ignoreDuplicates cobre apenas a
      // corrida concorrente entre o preview e este commit, não os duplicados
      // já filtrados acima.
      const { data: batchRows, error: insErr } = await admin
        .from("bank_transactions")
        .upsert(slice, { onConflict: "company_id,bank_account_key,fingerprint", ignoreDuplicates: true })
        .select("id, transaction_date, amount, direction, description, counterparty_name, reference, status");
      if (insErr) throw new Error(insErr.message);
      if (batchRows) inserted.push(...batchRows);
    }

    const suggestionsCreated = await generateSuggestions(admin, companyId, inserted);
    const importedRows = inserted.length;

    await admin
      .from("bank_statement_imports")
      .update({
        status: "completed",
        imported_rows: importedRows,
        duplicate_rows: duplicateRows,
        completed_at: new Date().toISOString(),
      })
      .eq("id", imp.id);

    await auditLog(
      {
        companyId,
        actorId: userId,
        action: "bank_statement_imported",
        entityType: "bank_statement_import",
        entityId: imp.id,
        meta: { file_name: fileName, total: transactions.length, imported: importedRows, duplicates: duplicateRows, suggestions: suggestionsCreated },
        source: "dashboard",
      },
      admin,
    );

    return { ok: true, importId: imp.id, imported: importedRows, duplicates: duplicateRows, suggestions: suggestionsCreated };
  } catch (e) {
    await admin
      .from("bank_statement_imports")
      .update({ status: "failed", error_message: e instanceof Error ? e.message.slice(0, 500) : "erro" })
      .eq("id", imp.id);
    return { ok: false, error: "Falha ao processar movimentos.", status: 500 };
  }
}
