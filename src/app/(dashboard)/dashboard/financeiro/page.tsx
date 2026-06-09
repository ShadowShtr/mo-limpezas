import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getFinancialDashboard } from "@/app/actions/financial-dashboard";
import { FinancialDashboardClient } from "./_components/financial-dashboard-client";

export const metadata = { title: "Financeiro — Escala" };

export default async function FinanceiroPage() {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = profile?.company_id ?? "";
  const result    = await getFinancialDashboard(companyId);

  const now = new Date();
  const yearLabel = now.getFullYear().toString();

  return (
    <div>
      <Header
        title="Dashboard Financeiro"
        subtitle={`Visão geral ${yearLabel}`}
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <FinancialDashboardClient
          data={result.ok ? result.data : null}
          error={result.ok ? null : result.error}
          companyId={companyId}
        />
      </div>
    </div>
  );
}
