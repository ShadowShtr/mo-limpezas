import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getAccountsData } from "@/app/actions/cash-flow";
import { ContasClient } from "./_components/contas-client";
import { Header } from "@/components/layout/header";

export default async function ContasPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const res = await getAccountsData(profile.company_id);

  return (
    <div>
      <Header title="Contas a Pagar e a Receber" subtitle="Extrato de pendências financeiras" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 max-w-[1400px]">
        <ContasClient
          toReceive={res.ok ? res.toReceive : []}
          toPay={res.ok ? res.toPay : []}
          expenses={res.ok ? res.expenses : []}
          companyId={profile.company_id}
          error={res.ok ? null : res.error}
        />
      </div>
    </div>
  );
}
