"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { revalidateBusinessPaths } from "@/lib/revalidate-business";

// Painel de recuperação (/dashboard/sistema/auditoria): restaura o estado
// anterior de uma entrada do histórico universal (data_history, migração 059).
//
// Regras de segurança:
// - só admin/gestor;
// - só tabelas da lista branca;
// - só entradas UPDATE (linhas apagadas restauram-se com
//   scripts/restore-from-history.mjs, que reinsere a linha completa);
// - restaura APENAS os campos que a entrada alterou (não a linha inteira);
// - motivo obrigatório; o restauro fica no auditLog E no próprio data_history
//   (o trigger capta o update de restauro — até o restauro é reversível);
// - update confirma linhas afetadas: 0 linhas = erro, nunca "sucesso".

const RESTORABLE_TABLES = [
  "clients", "locations", "contracts", "services", "invoices", "invoice_items",
] as const;
type RestorableTable = (typeof RESTORABLE_TABLES)[number];

// Campos que nunca se restauram por cima (geridos pelo sistema).
const SKIP_FIELDS = new Set(["id", "company_id", "created_at", "updated_at", "contract_synced_at"]);

export async function restoreHistoryEntry(formData: FormData) {
  const back = "/dashboard/sistema/auditoria";
  const fail = (msg: string): never => redirect(`${back}?erro=${encodeURIComponent(msg)}`);

  const entryId = Number(formData.get("entryId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!Number.isFinite(entryId)) return fail("Entrada inválida.");
  if (reason.length < 5) return fail("O motivo do restauro é obrigatório (mínimo 5 caracteres).");

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return fail(guard.error);
  const { profile, admin } = guard;

  const { data: entry, error: entryErr } = await admin
    .from("data_history")
    .select("*")
    .eq("id", entryId)
    .single();
  if (entryErr || !entry) return fail("Entrada do histórico não encontrada.");

  const e = entry;
  if (!RESTORABLE_TABLES.includes(e.table_name as RestorableTable)) {
    return fail(`Tabela "${e.table_name}" não é restaurável por aqui.`);
  }
  // Isolamento multi-tenant: entradas de outra empresa nunca são restauráveis.
  if (e.company_id && e.company_id !== profile.company_id) return fail("Sem permissão.");
  if (e.op !== "UPDATE") {
    return fail("Linhas APAGADAS restauram-se com: node scripts/restore-from-history.mjs --restore " + e.id);
  }

  // Só os campos que ESTA alteração mudou voltam ao valor anterior.
  const oldData = e.old_data ?? {};
  const newData = e.new_data ?? {};
  const changed = (e.changed_fields && e.changed_fields.length > 0)
    ? e.changed_fields
    : Object.keys(newData).filter((k) => JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]));

  const patch: Record<string, unknown> = {};
  for (const k of changed) {
    if (SKIP_FIELDS.has(k)) continue;
    if (k in oldData) patch[k] = oldData[k];
  }
  if (Object.keys(patch).length === 0) return fail("Nada restaurável nesta entrada (só campos de sistema mudaram).");

  const { data: updated, error } = await admin
    .from(e.table_name as "clients")
    .update(patch as never)
    .eq("id", e.row_id)
    .select("id");

  if (error) return fail(`O restauro foi recusado: ${error.message}`);
  if (!updated || updated.length === 0) {
    return fail("0 linhas afetadas — o registo já não existe (para reinserir linhas apagadas usa o script de restauro).");
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "history_restored",
    entityType: e.table_name,
    entityId: e.row_id,
    before: newData,
    after: patch,
    source: "dashboard",
    meta: { origem: "painel_auditoria", history_id: e.id, reason },
  }, admin);

  revalidateBusinessPaths({
    scopes: ["clientes", "calendario", "contratos", "cobrancas", "financeiro", "locais"],
  });

  redirect(`${back}?msg=${encodeURIComponent(`Restaurado: ${Object.keys(patch).join(", ")} (entrada #${e.id}).`)}`);
}
