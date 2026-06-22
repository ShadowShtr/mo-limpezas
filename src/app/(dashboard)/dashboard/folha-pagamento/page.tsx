import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
import { Header } from "@/components/layout/header";
import { calculateAndSavePayroll, getPayrollRecords } from "@/app/actions/payroll";
import { PayrollClient } from "./_components/payroll-client";

export const metadata = { title: "Folha de Pagamento — Escala" };

interface SearchParams { mes?: string }

export default async function FolhaPagamentoPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
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

  const result = await getPayrollRecords(companyId, year, month);
  let records = result.ok ? result.records : [];

  const { count: activePayrollProfiles } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .in("role", ["colaborador", "gestor", "admin"]);

  if (activePayrollProfiles && records.length < activePayrollProfiles) {
    const refreshed = await calculateAndSavePayroll(companyId, year, month);
    records = refreshed.ok ? refreshed.records : records;
  }

  const mesLabel = new Date(year, month - 1).toLocaleDateString("pt-PT", {
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      <Header
        title="Folha de Pagamento"
        subtitle={mesLabel}
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <PayrollClient
          initialRecords={records}
          companyId={companyId}
          mesParam={mesParam}
          year={year}
          month={month}
          mesLabel={mesLabel}
        />
      </div>
    </div>
  );
}
