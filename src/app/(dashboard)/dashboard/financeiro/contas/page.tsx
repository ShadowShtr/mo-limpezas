import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getAccountsData } from "@/app/actions/cash-flow";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { ContasClient } from "./_components/contas-client";

export const metadata = { title: "Contas — Escala" };

export default async function ContasPage({
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
  // O período entra na casca para a navegação o preservar. `getAccountsData`
  // continua a ler exactamente o que lia — este PR não muda semântica de
  // leitura nenhuma. Integração do período nesta vista fica para o PR B.
  const period = parseFinancePeriod(params.mes);

  const res = await getAccountsData(profile.company_id);

  return (
    <FinanceShell
      period={period}
      title="Contas"
      subtitle="A pagar e a receber · pendências financeiras"
    >
      <ContasClient
        toReceive={res.ok ? res.toReceive : []}
        toPay={res.ok ? res.toPay : []}
        expenses={res.ok ? res.expenses : []}
        companyId={profile.company_id}
        error={res.ok ? null : res.error}
      />
    </FinanceShell>
  );
}
