import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { AbsenceTable } from "./_components/absence-table";
import { AbsenceSheet } from "./_components/absence-sheet";
import { VacationRequests } from "./_components/vacation-requests";
import { getPendingVacationRequests } from "@/app/actions/vacation";
import { AlertTriangle } from "lucide-react";

interface SearchParams {
  mes?: string;
  colaborador?: string;
}

export default async function FaltasPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = profile?.company_id ?? "";

  // Período padrão: mês atual
  const now = new Date();
  const mesParam = params.mes ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, month] = mesParam.split("-").map(Number);
  const startOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const endOfMonth = new Date(year, month, 0).toISOString().split("T")[0];

  // Colaboradores da empresa
  const { data: colaboradores } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .in("role", ["colaborador", "gestor"])
    .order("full_name");

  // Faltas do período (com join manual)
  let absencesQuery = admin
    .from("absences")
    .select("id, collaborator_id, absence_type, starts_on, ends_on, notes, replaced_by, created_by, created_at")
    .eq("company_id", companyId)
    .lte("starts_on", endOfMonth)
    .gte("ends_on", startOfMonth)
    .order("starts_on", { ascending: false });

  if (params.colaborador) {
    absencesQuery = absencesQuery.eq("collaborator_id", params.colaborador);
  }

  const { data: rawAbsences } = await absencesQuery;

  // Enriquecer com nomes
  const profilesMap = Object.fromEntries(
    (colaboradores ?? []).map((c) => [c.id, c.full_name]),
  );

  const nowMs = Date.now();
  const absences = (rawAbsences ?? []).map((a) => ({
    id: a.id,
    collaborator_id: a.collaborator_id,
    collaborator_name: profilesMap[a.collaborator_id] ?? "—",
    absence_type: a.absence_type,
    starts_on: a.starts_on,
    ends_on: a.ends_on,
    notes: a.notes,
    replaced_by: a.replaced_by,
    replaced_by_name: a.replaced_by ? (profilesMap[a.replaced_by] ?? null) : null,
    is_new: a.created_by === a.collaborator_id && (nowMs - new Date(a.created_at).getTime()) < 48 * 60 * 60 * 1000,
  }));

  // Contar faltas não substituídas
  const semSubstituto = absences.filter((a) => !a.replaced_by).length;

  // Pedidos de férias (colaboradores → gestor)
  const vacationRequests = await getPendingVacationRequests();

  return (
    <div>
      <Header
        title="Faltas"
        subtitle={`${absences.length} registo${absences.length !== 1 ? "s" : ""} — ${new Date(year, month - 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" })}`}
        actions={
          <AbsenceSheet
            colaboradores={colaboradores ?? []}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <AlertTriangle className="w-4 h-4" />
                Registar falta
              </button>
            }
          />
        }
      />

      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-5 mx-auto max-w-[1400px]">
        {/* Pedidos de férias pendentes */}
        <VacationRequests requests={vacationRequests} />

        {/* Alerta de faltas sem substituto */}
        {semSubstituto > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-orange-50 border border-orange-200 text-orange-700 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              <strong>{semSubstituto}</strong> falta{semSubstituto !== 1 ? "s" : ""} sem substituto atribuído.
              Clica em "Sugerir substituto" na tabela para resolver.
            </span>
          </div>
        )}

        {/* Filtros */}
        <form method="GET" className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Mês</label>
            <input
              type="month"
              name="mes"
              defaultValue={mesParam}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Colaborador</label>
            <select
              name="colaborador"
              defaultValue={params.colaborador ?? ""}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="">Todos</option>
              {(colaboradores ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Filtrar
          </button>
        </form>

        {/* Tabela */}
        <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
          <AbsenceTable absences={absences} />
        </div>
      </div>
    </div>
  );
}
