import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getAccountsData } from "@/app/actions/cash-flow";
import { ContasClient } from "./_components/contas-client";

export default async function ContasPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const res = await getAccountsData(profile.company_id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">Contas a Pagar e a Receber</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-0.5">Extrato de pendências financeiras</p>
      </div>

      <ContasClient
        toReceive={res.ok ? res.toReceive : []}
        toPay={res.ok ? res.toPay : []}
        error={res.ok ? null : res.error}
      />
    </div>
  );
}
