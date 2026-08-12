import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getFinancialDashboard, getOperationalSummary } from "@/app/actions/financial-dashboard";
import { getUnbilledServices } from "@/app/actions/invoices";
import { getFinanceDashboardV2 } from "@/app/actions/finance-dashboard-v2";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { FinancialDashboardClient } from "./_components/financial-dashboard-client";

export const metadata = { title: "Financeiro — Escala" };

export default async function FinanceiroPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const params   = await searchParams;
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = profile?.company_id ?? "";

  // Financeiro V2 (PR A): o período vem da URL, não de `new Date()`.
  const period = parseFinancePeriod(params.mes);

  // `getUnbilledServices` é leitura pura — só faz `select`. Alimenta o único
  // alerta desta vista que tem fonte real. Não escreve nada durante o render.
  // 🔴 `getFinanceDashboardV2` é o motor novo: recebe o período e governa
  //    todos os números. `getFinancialDashboard` fica só para a série de 12
  //    meses do gráfico, que ainda não existe no modelo novo — e é a única
  //    coisa que dele se usa.
  const [snapshotResult, result, summaryResult, unbilledResult] = await Promise.all([
    getFinanceDashboardV2({ year: period.year, month: period.month }),
    getFinancialDashboard(companyId),
    getOperationalSummary(),
    getUnbilledServices(companyId),
  ]);

  const unbilled = unbilledResult.ok
    ? {
        count: unbilledResult.services.length,
        total: unbilledResult.services.reduce((soma, s) => soma + (s.value ?? 0), 0),
      }
    : null;

  return (
    <FinanceShell
      period={period}
      title="Resumo"
      subtitle="Visão geral do módulo financeiro"
    >
      <FinancialDashboardClient
        data={result.ok ? result.data : null}
        error={result.ok ? null : result.error}
        companyId={companyId}
        initialSummary={summaryResult.ok ? summaryResult.data : null}
        unbilled={unbilled}
        snapshot={snapshotResult.ok ? snapshotResult.snapshot : null}
        snapshotError={snapshotResult.ok ? null : snapshotResult.error}
      />
    </FinanceShell>
  );
}
