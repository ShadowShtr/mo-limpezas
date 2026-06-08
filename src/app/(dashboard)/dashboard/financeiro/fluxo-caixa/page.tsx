import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCashFlowEntries } from "@/app/actions/cash-flow";
import { CashFlowClient } from "./_components/cash-flow-client";

export default async function FluxoCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const params = await searchParams;
  const now = new Date();
  const mesParam = params.mes ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [yearStr, monthStr] = mesParam.split("-");
  const year  = parseInt(yearStr);
  const month = parseInt(monthStr);

  const res = await getCashFlowEntries(profile.company_id, { year, month });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text-main)]">Fluxo de Caixa</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-0.5">Registo de todas as entradas e saídas</p>
        </div>
      </div>

      <CashFlowClient
        initialData={res.ok ? { entries: res.entries, balance: res.balance, entradas: res.entradas, saidas: res.saidas, pendentes: res.pendentes } : null}
        error={res.ok ? null : res.error}
        companyId={profile.company_id}
        mesParam={mesParam}
        year={year}
        month={month}
      />
    </div>
  );
}
