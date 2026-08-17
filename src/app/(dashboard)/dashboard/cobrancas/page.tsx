import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getInvoices, getUnbilledServices } from "@/app/actions/invoices";
import { getDailyBilling } from "@/app/actions/daily-billing";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod, formatFinancePeriod } from "@/lib/finance-period";
import { todayInLisbon } from "@/lib/lisbon-time";
import { CobrancasTabs } from "./_components/cobrancas-tabs";

export const metadata = { title: "Cobranças — Escala" };

interface SearchParams { mes?: string; cliente?: string }

export default async function CobrancastPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
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

  const period = parseFinancePeriod(params.mes);
  // A cobrança diária continua ancorada em HOJE, não no período do módulo:
  // é uma vista operacional do dia, não do mês. Trocar isso seria mudar
  // semântica, e este PR não muda nenhuma.
  const todayStr = todayInLisbon();

  const [result, unbilledResult, dailyResult] = await Promise.all([
    getInvoices(companyId, period.year, period.month),
    getUnbilledServices(companyId),
    getDailyBilling(todayStr),
  ]);
  const invoices         = result.ok ? result.invoices : [];
  const unbilledServices = unbilledResult.ok ? unbilledResult.services : [];

  return (
    <FinanceShell
      period={period}
      title="Cobranças"
      subtitle="Controlo diário e faturas do período"
    >
      <CobrancasTabs
        initialInvoices={invoices}
        unbilledServices={unbilledServices}
        companyId={companyId}
        clienteInicial={params.cliente}
        mesParam={period.key}
        year={period.year}
        month={period.month}
        mesLabel={formatFinancePeriod(period)}
        dailyDate={todayStr}
        dailyData={dailyResult.ok ? dailyResult.data : null}
        dailyError={dailyResult.ok ? null : dailyResult.error}
      />
    </FinanceShell>
  );
}
