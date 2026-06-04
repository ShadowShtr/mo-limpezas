import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getReportsData } from "@/app/actions/reports";
import { ReportsTabs } from "./_components/reports-tabs";

interface SearchParams {
  mes?: string;
}

export default async function RelatoriosPage({
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

  const now = new Date();
  const mesParam = params.mes ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, month] = mesParam.split("-").map(Number);
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(year, month, 0).toISOString().split("T")[0];

  const mesLabel = new Date(year, month - 1).toLocaleDateString("pt-PT", {
    month: "long",
    year: "numeric",
  });

  const data = await getReportsData(companyId, startDate, endDate);

  const totalServicos = data.servicosPorEquipa.reduce((s, r) => s + r.total, 0);
  const totalReceita = data.receita.reduce((s, r) => s + r.total_receita, 0);

  return (
    <div>
      <Header
        title="Relatórios"
        subtitle={mesLabel}
      />

      <div className="p-6 max-w-[1400px] space-y-5">
        {/* Filtro de período */}
        <form method="GET" className="flex items-end gap-3">
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Mês</label>
            <input
              type="month"
              name="mes"
              defaultValue={mesParam}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Filtrar
          </button>
        </form>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Serviços no período"
            value={totalServicos.toString()}
            sub={`${data.servicosPorEquipa.reduce((s, r) => s + r.concluido, 0)} concluídos`}
          />
          <KpiCard
            label="Receita (s/ IVA)"
            value={totalReceita.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
            sub={`${data.receita.length} cliente${data.receita.length !== 1 ? "s" : ""}`}
          />
          <KpiCard
            label="Horas trabalhadas"
            value={`${Math.floor(data.horas.reduce((s, r) => s + r.actual_minutes, 0) / 60)}h`}
            sub={`${data.horas.length} colaborador${data.horas.length !== 1 ? "es" : ""}`}
          />
          <KpiCard
            label="Dias de falta"
            value={data.absentismo.reduce((s, r) => s + r.total_dias, 0).toString()}
            sub={`${data.absentismo.length} colaborador${data.absentismo.length !== 1 ? "es" : ""} afetado${data.absentismo.length !== 1 ? "s" : ""}`}
          />
        </div>

        {/* Tabs */}
        <ReportsTabs
          horas={data.horas}
          absentismo={data.absentismo}
          receita={data.receita}
          servicosPorEquipa={data.servicosPorEquipa}
          mesLabel={mesLabel}
          mesParam={mesParam}
          vatRate={data.vatRate}
        />
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <p className="text-xs text-[var(--color-text-muted)] mb-1">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-main)]">{value}</p>
      <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{sub}</p>
    </div>
  );
}
