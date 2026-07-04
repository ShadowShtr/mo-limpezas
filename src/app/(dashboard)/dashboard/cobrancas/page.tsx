import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getInvoices, getUnbilledServices } from "@/app/actions/invoices";
import { getDailyBilling } from "@/app/actions/daily-billing";
import { CobrancasTabs } from "./_components/cobrancas-tabs";

export const metadata = { title: "Cobranças — Escala" };

interface SearchParams { mes?: string }

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

  const now = new Date();
  const mesParam = params.mes ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, month] = mesParam.split("-").map(Number);
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const [result, unbilledResult, dailyResult] = await Promise.all([
    getInvoices(companyId, year, month),
    getUnbilledServices(companyId),
    getDailyBilling(todayStr),
  ]);
  const invoices         = result.ok ? result.invoices : [];
  const unbilledServices = unbilledResult.ok ? unbilledResult.services : [];

  const mesLabel = new Date(year, month - 1).toLocaleDateString("pt-PT", {
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      <Header
        title="Cobranças"
        subtitle="Controlo diário e faturas mensais"
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <CobrancasTabs
          initialInvoices={invoices}
          unbilledServices={unbilledServices}
          companyId={companyId}
          mesParam={mesParam}
          year={year}
          month={month}
          mesLabel={mesLabel}
          dailyDate={todayStr}
          dailyData={dailyResult.ok ? dailyResult.data : null}
          dailyError={dailyResult.ok ? null : dailyResult.error}
        />
      </div>
    </div>
  );
}
