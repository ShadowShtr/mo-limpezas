import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getPayrollRecords } from "@/app/actions/payroll";
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
  const records = result.ok ? result.records : [];

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
      <div className="p-6 max-w-[1400px]">
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
