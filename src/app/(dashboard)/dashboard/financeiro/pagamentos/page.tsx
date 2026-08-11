import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPayments } from "@/app/actions/payments";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { PaymentsClient } from "./_components/payments-client";

export const metadata = { title: "Pagamentos — Escala" };

export default async function PagamentosPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const period = parseFinancePeriod(params.mes);

  const res = await getPayments(period.year, period.month);

  return (
    <FinanceShell
      period={period}
      title="Pagamentos"
      subtitle="Fixos e variáveis do período, com estado de pagamento"
    >
      <PaymentsClient
        initialData={res.ok ? res.data : null}
        error={res.ok ? null : res.error}
        mesParam={period.key}
        year={period.year}
        month={period.month}
      />
    </FinanceShell>
  );
}
