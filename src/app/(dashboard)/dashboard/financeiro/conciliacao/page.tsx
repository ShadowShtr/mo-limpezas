import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { getBankReconciliationData } from "@/app/actions/bank-reconciliation";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { ReconciliationClient } from "./_components/reconciliation-client";

export const metadata = { title: "Conciliação Bancária — Escala" };

export default async function ConciliacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Só admin/gestor — colaborador nunca acede a dados bancários.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile?.company_id) redirect("/login");
  if (!["admin", "gestor"].includes(profile.role)) redirect("/dashboard");

  const params = await searchParams;
  const period = parseFinancePeriod(params.mes);

  // O mês do módulo governa também esta vista — antes mostrava os últimos
  // 500 movimentos de sempre, com o cabeçalho a dizer outro mês.
  const res = await getBankReconciliationData({ period: { year: period.year, month: period.month } });

  return (
    <FinanceShell
      period={period}
      title="Conciliação"
      subtitle="Importar extratos e cruzar com lançamentos financeiros"
    >
      {/* A identidade da vista é o período — ver a nota em
          `financeiro/pagamentos/page.tsx`. Mudar de mês recria a
          instância e descarta o estado transitório do mês anterior. */}
      <ReconciliationClient
        key={period.key}
        initial={res.ok ? { transactions: res.transactions, imports: res.imports, accounts: res.accounts } : null}
        error={res.ok ? null : res.error}
      />
    </FinanceShell>
  );
}
