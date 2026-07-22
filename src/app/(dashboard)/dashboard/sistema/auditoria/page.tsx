import Link from "next/link";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { restoreHistoryEntry } from "@/app/actions/data-history";
import type { Database } from "@/types/database";

// Painel de recuperação — a "rota de fuga" visível para a gestão.
// Lista o histórico universal (data_history, migração 059): toda a alteração
// e eliminação em tabelas críticas, com antes/depois campo a campo, e um botão
// para restaurar o valor anterior sem precisar de linha de comandos.

export const dynamic = "force-dynamic";

type HistoryRow = Database["public"]["Tables"]["data_history"]["Row"];

const TABLE_LABELS: Record<string, string> = {
  clients: "Cliente",
  locations: "Local",
  contracts: "Contrato",
  services: "Serviço",
  invoices: "Fatura",
  invoice_items: "Linha de fatura",
};

const FINANCIAL_FIELDS = new Set([
  "fixed_price", "fixed_monthly", "apply_vat", "hourly_rate", "manual_value",
  "calculated_value", "paid_amount", "unit_price", "total", "vat_exempt",
]);

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function diffOf(row: HistoryRow): Array<{ field: string; before: unknown; after: unknown; financial: boolean }> {
  const oldData = row.old_data ?? {};
  const newData = row.new_data ?? {};
  const keys = row.changed_fields?.length
    ? row.changed_fields
    : Object.keys(newData).filter((k) => JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]));
  return keys
    .filter((k) => !["updated_at", "contract_synced_at"].includes(k))
    .map((k) => ({ field: k, before: oldData[k], after: newData[k], financial: FINANCIAL_FIELDS.has(k) }));
}

export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{ tabela?: string; msg?: string; erro?: string }>;
}) {
  const { tabela, msg, erro } = await searchParams;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  const canView = profile && ["admin", "gestor"].includes(profile.role);

  let rows: HistoryRow[] = [];
  let netInactive = false;
  if (canView) {
    let query = admin
      .from("data_history")
      .select("*")
      .order("changed_at", { ascending: false })
      .limit(80);
    if (tabela && TABLE_LABELS[tabela]) query = query.eq("table_name", tabela);
    const { data, error } = await query;
    if (error) netInactive = true;   // tabela ainda não existe → 059 por aplicar
    rows = (data as HistoryRow[] | null) ?? [];
  }

  return (
    <div>
      <Header
        title="Auditoria de Alterações"
        subtitle="Histórico universal da rede de segurança — tudo o que mudou, quem mudou, e o botão para restaurar"
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-4 mx-auto max-w-[1100px]">

        {!canView && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Sem permissão para ver esta página.
          </div>
        )}

        {msg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            ✅ {msg}
          </div>
        )}
        {erro && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ❌ {erro}
          </div>
        )}

        {canView && netInactive && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            A rede de segurança ainda não está ativa nesta base — aplica as migrações 059/060
            (<code>node scripts/run-migrations.mjs</code>) e este painel começa a registar tudo.
          </div>
        )}

        {canView && !netInactive && (
          <>
            {/* Filtro por tabela */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[var(--color-text-muted)] mr-1">Filtrar:</span>
              <Link href="/dashboard/sistema/auditoria"
                className={`px-2.5 py-1 rounded-full border ${!tabela ? "bg-[var(--color-primary)] text-white border-transparent" : "border-[var(--color-border)] text-[var(--color-text-sub)]"}`}>
                Tudo
              </Link>
              {Object.entries(TABLE_LABELS).map(([t, label]) => (
                <Link key={t} href={`/dashboard/sistema/auditoria?tabela=${t}`}
                  className={`px-2.5 py-1 rounded-full border ${tabela === t ? "bg-[var(--color-primary)] text-white border-transparent" : "border-[var(--color-border)] text-[var(--color-text-sub)]"}`}>
                  {label}
                </Link>
              ))}
            </div>

            {rows.length === 0 && (
              <div className="rounded-xl border border-[var(--color-border)] bg-white px-4 py-6 text-sm text-[var(--color-text-muted)] text-center">
                Ainda sem alterações registadas{tabela ? " nesta tabela" : ""}. A rede regista tudo a partir de agora.
              </div>
            )}

            <div className="space-y-3">
              {rows.map((row) => {
                const changes = row.op === "UPDATE" ? diffOf(row) : [];
                const hasFinancial = changes.some((c) => c.financial);
                return (
                  <div key={row.id}
                    className={`rounded-xl border bg-white p-4 ${hasFinancial ? "border-amber-300" : "border-[var(--color-border)]"}`}>
                    <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                      <span className="font-semibold text-[var(--color-text-main)]">
                        {TABLE_LABELS[row.table_name] ?? row.table_name}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-full font-medium ${row.op === "DELETE" ? "bg-red-100 text-red-700" : "bg-[var(--color-background)] text-[var(--color-text-sub)]"}`}>
                        {row.op === "DELETE" ? "APAGADO" : "ALTERADO"}
                      </span>
                      {hasFinancial && (
                        <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">financeiro</span>
                      )}
                      <span className="text-[var(--color-text-muted)]">
                        #{row.id} · {new Date(row.changed_at).toLocaleString("pt-PT")} ·{" "}
                        {row.actor ? `utilizador ${row.actor.slice(0, 8)}` : "sistema"} ·{" "}
                        registo {row.row_id.slice(0, 8)}
                      </span>
                    </div>

                    {row.op === "DELETE" ? (
                      <p className="text-sm text-[var(--color-text-sub)]">
                        Linha apagada — os dados completos estão guardados. Para reinserir:{" "}
                        <code className="text-xs bg-[var(--color-background)] px-1.5 py-0.5 rounded">
                          node scripts/restore-from-history.mjs --restore {row.id}
                        </code>
                      </p>
                    ) : (
                      <>
                        <table className="w-full text-sm mb-3">
                          <tbody>
                            {changes.map((c) => (
                              <tr key={c.field} className="border-t border-[var(--color-border)]/60">
                                <td className="py-1 pr-3 font-medium text-[var(--color-text-sub)] whitespace-nowrap">{c.field}</td>
                                <td className="py-1 pr-2 text-[var(--color-text-muted)] line-through">{fmt(c.before)}</td>
                                <td className="py-1 text-[var(--color-text-main)]">→ {fmt(c.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {changes.length > 0 && (
                          <form action={restoreHistoryEntry} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="entryId" value={row.id} />
                            <input
                              type="text"
                              name="reason"
                              required
                              minLength={5}
                              placeholder="Motivo do restauro (obrigatório)"
                              className="flex-1 min-w-[220px] text-xs border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                            />
                            <button type="submit"
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors">
                              Restaurar valores anteriores
                            </button>
                          </form>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-[var(--color-text-muted)] pt-2">
              A mostrar as últimas {rows.length} alterações. O restauro repõe apenas os campos alterados
              nessa entrada, exige motivo, fica auditado — e é ele próprio reversível (também entra no histórico).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
