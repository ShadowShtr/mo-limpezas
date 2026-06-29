// Geração de sugestões de conciliação contra a BD.
// Partilhado pelo endpoint de importação e pela ação de "recalcular sugestões".
// Usa o admin client (já validado a montante) — NÃO faz verificação de permissões.

import type { createAdminClient } from "@/lib/supabase/admin";
import { suggestMatches, type CashEntryLike } from "./matching";

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
