import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getFinancialDashboard, getOperationalSummary } from "@/app/actions/financial-dashboard";
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

  const [result, summaryResult] = await Promise.all([
    getFinancialDashboard(companyId),
    getOperationalSummary(),
  ]);

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
      />
    </FinanceShell>
  );
}
