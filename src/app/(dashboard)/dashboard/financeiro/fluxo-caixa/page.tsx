import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCashFlowEntries } from "@/app/actions/cash-flow";
import { getExpenseCategoryCatalog, type ExpenseCategoryCatalog } from "@/app/actions/expense-categories";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { CashFlowClient } from "./_components/cash-flow-client";

export const metadata = { title: "Fluxo de Caixa — Escala" };

export default async function FluxoCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string; categoria?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("auth_user_id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const params = await searchParams;
  const period = parseFinancePeriod(params.mes);

  const [res, categoriesRes] = await Promise.all([
    getCashFlowEntries(profile.company_id, { year: period.year, month: period.month }),
    getExpenseCategoryCatalog(),
  ]);

  const catalogoIndisponivel: ExpenseCategoryCatalog = {
    available: false, categories: [], suggestions: [], missingSuggestions: [],
  };

  return (
    <FinanceShell
      period={period}
      title="Fluxo de Caixa"
      subtitle="Entradas e saídas do período"
    >
      {/* A identidade da vista é o período — ver a nota em
          `financeiro/pagamentos/page.tsx`. Mudar de mês recria a
          instância e descarta o estado transitório do mês anterior. */}
      <CashFlowClient
        key={period.key}
        initialData={res.ok ? { entries: res.entries, balance: res.balance, entradas: res.entradas, saidas: res.saidas, pendentes: res.pendentes } : null}
        error={res.ok ? null : res.error}
        companyId={profile.company_id}
        year={period.year}
        month={period.month}
        expenseCatalog={categoriesRes.ok ? categoriesRes.catalog : catalogoIndisponivel}
        // Chega assim do donut do Resumo — o mesmo âmbito, a mesma lista.
        categoriaInicial={params.categoria ?? null}
      />
    </FinanceShell>
  );
}
