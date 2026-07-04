import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getFinancialDashboard, getOperationalSummary } from "@/app/actions/financial-dashboard";
import { FinancialDashboardClient } from "./_components/financial-dashboard-client";
import { PaymentsReminderBanner } from "../_components/payments-reminder-banner";

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
  const [result, summaryResult] = await Promise.all([
    getFinancialDashboard(companyId),
    getOperationalSummary(),
  ]);

  const now = new Date();
  const yearLabel = now.getFullYear().toString();

  return (
    <div>
      <Header
        title="Financeiro"
        subtitle={`Resumo do dia, semana e mês · Visão geral ${yearLabel}`}
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px] space-y-6">
        <PaymentsReminderBanner />
        <FinancialDashboardClient
          data={result.ok ? result.data : null}
          error={result.ok ? null : result.error}
          companyId={companyId}
          initialSummary={summaryResult.ok ? summaryResult.data : null}
        />
      </div>
    </div>
  );
}
