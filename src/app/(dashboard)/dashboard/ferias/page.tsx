import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { PontoTabs } from "../registo-ponto/_components/ponto-tabs";
import { getAllVacationsOverview } from "@/app/actions/vacation";
import { todayInLisbon } from "@/lib/lisbon-time";
import { CalendarClock, Plane } from "lucide-react";

interface SearchParams {
  ano?: string;
  colaborador?: string;
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function FeriasPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const currentYear = Number(todayInLisbon().slice(0, 4));
  const year = params.ano ? Number(params.ano) : currentYear;
  const overview = await getAllVacationsOverview(year);
  const selectedId = params.colaborador ?? "";
  const rows = selectedId ? overview.filter((e) => e.id === selectedId) : overview;

  return (
    <div>
      <Header title="Férias" subtitle={`Saldo e períodos de férias — ${year} (modelo legal português a partir do início de contrato)`} />
      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-5 mx-auto max-w-[1400px]">
        <PontoTabs />

        <form method="GET" className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Ano</label>
            <input
              type="number"
              name="ano"
              defaultValue={year}
              className="w-28 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Funcionário</label>
            <select
              name="colaborador"
              defaultValue={selectedId}
              className="min-w-[220px] px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="">Todos</option>
              {overview.map((e) => (
                <option key={e.id} value={e.id}>{e.full_name}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Listar
          </button>
        </form>

        <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--color-text-muted)]">
              <Plane className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">
                {selectedId ? "Colaborador não encontrado." : "Nenhum colaborador ativo encontrado."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)] text-xs uppercase tracking-wide">
                    <th className="text-left px-4 py-3 font-medium">Colaborador</th>
                    <th className="text-left px-4 py-3 font-medium">Contrato desde</th>
                    <th className="text-left px-4 py-3 font-medium">Direito no ano</th>
                    <th className="text-left px-4 py-3 font-medium">Gozadas ({year})</th>
                    <th className="text-left px-4 py-3 font-medium">Disponíveis</th>
                    <th className="text-left px-4 py-3 font-medium">Saldo manual</th>
                    <th className="text-left px-4 py-3 font-medium">Períodos de férias</th>
                    <th className="text-left px-4 py-3 font-medium">Pedidos pendentes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {rows.map((e) => (
                    <tr key={e.id} className="hover:bg-[var(--color-background)] transition-colors align-top">
                      <td className="px-4 py-3 font-medium text-[var(--color-text-main)]">{e.full_name}</td>
                      <td className="px-4 py-3 text-[var(--color-text-sub)]">
                        {e.contract_start ? formatDate(e.contract_start) : (
                          <span className="text-[var(--color-text-muted)]">— sem data —</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-text-sub)]">
                        {e.entitlement_days != null ? `${e.entitlement_days}d` : "—"}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-text-sub)]">{e.used_days_year}d</td>
                      <td className="px-4 py-3">
                        {e.available_days != null ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                            {e.available_days}d
                          </span>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-text-sub)]">{e.vacation_balance}d</td>
                      <td className="px-4 py-3">
                        {e.periods.length === 0 ? (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {e.periods.map((p, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700"
                              >
                                {formatDate(p.starts_on)}
                                {p.starts_on !== p.ends_on && <> → {formatDate(p.ends_on)}</>}
                                <span className="opacity-70">({p.days}d)</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.pending_requests > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                            <CalendarClock className="w-3 h-3" />{e.pending_requests}
                          </span>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          <strong>Direito no ano</strong> e <strong>Disponíveis</strong> são calculados a partir da data de início de
          contrato, segundo o Código do Trabalho: no ano de admissão, 2 dias úteis por mês completo (após 6 meses),
          até 20 dias; a partir do ano civil seguinte, 22 dias úteis. O <strong>Saldo manual</strong> é o valor
          editável na ficha do colaborador, mantido à parte para referência.
        </p>
      </div>
    </div>
  );
}
