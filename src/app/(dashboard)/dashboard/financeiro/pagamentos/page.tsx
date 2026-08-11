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

  // Esta vista participa no período do módulo, como as outras seis.
  //
  // Esteve isolada, e com razão: `getPayments` chamava `ensureMonth`, e um
  // seletor de período teria transformado "mudar de mês" em "gerar esse mês".
  // A PR C tirou a escrita do caminho de leitura — abrir Setembro passou a ser
  // apenas ler Setembro, e Setembro vazio mostra-se vazio.
  const period = parseFinancePeriod(params.mes);

  const res = await getPayments(period.year, period.month);

  return (
    <FinanceShell
      period={period}
      title="Pagamentos"
      subtitle="Fixos e variáveis, com estado de pagamento"
    >
      <PaymentsClient
        initialData={res.ok ? res.data : null}
        error={res.ok ? null : res.error}
        year={period.year}
        month={period.month}
      />
    </FinanceShell>
  );
}
