import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFinanceLedger } from "@/app/actions/finance-ledger";
import { getExpenseCategoryCatalog } from "@/app/actions/expense-categories";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { UnifiedPaymentsClient } from "./_components/unified-payments-client";
import { PrepareRecurringMonth } from "./_components/prepare-recurring-month";

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
  const res = await getFinanceLedger(period.year, period.month);

  const catalogo = await getExpenseCategoryCatalog();
  const categorias = catalogo.ok && catalogo.catalog.available
    ? catalogo.catalog.categories.map((category) => ({ id: category.id, name: category.name }))
    : [];

  if (!res.ok) {
    return (
      <FinanceShell
        period={period}
        title="Pagamentos"
        subtitle="Obrigações e movimentos de caixa, sem duplicar o mesmo pagamento"
      >
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
        >
          <p className="font-semibold">Não foi possível carregar os pagamentos deste mês.</p>
          <p className="mt-1.5">{res.error}</p>
          <p className="mt-3 text-amber-800">
            Por segurança, criar e alterar registos está indisponível até a lista
            carregar — assim não se corre o risco de duplicar um pagamento que já
            exista. Tente recarregar a página ou escolher outro mês.
          </p>
        </div>
      </FinanceShell>
    );
  }

  return (
    <FinanceShell
      period={period}
      title="Pagamentos"
      subtitle="Obrigações e movimentos de caixa, sem duplicar o mesmo pagamento"
    >
      <div className="mb-4 flex justify-end">
        {/*
          Ler continua a não escrever. A geração só pode começar por este acto
          explícito: preview → confirmação → RPC atómica.
        */}
        <PrepareRecurringMonth year={period.year} month={period.month} />
      </div>

      <UnifiedPaymentsClient
        key={period.key}
        categories={categorias}
        rows={res.rows}
        error={null}
        companyId={res.companyId}
        year={period.year}
        month={period.month}
      />
    </FinanceShell>
  );
}
