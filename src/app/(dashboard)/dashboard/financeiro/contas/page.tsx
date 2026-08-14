import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getAccountsData } from "@/app/actions/cash-flow";
import { getExpenseCategoryCatalog, type ExpenseCategoryCatalog } from "@/app/actions/expense-categories";
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

  // 🔴 O período agora governa esta vista. Antes recebia `company_id` e
  //    devolvia toda a história, enquanto o seletor dizia outro mês.
  // As duas leituras são independentes: o catálogo de categorias falhar não
  // pode deixar a página das Contas sem contas.
  const [res, categoriesRes] = await Promise.all([
    getAccountsData({ year: period.year, month: period.month }),
    getExpenseCategoryCatalog(),
  ]);

  // 🔴 Indisponível, e não «vazio».
  //
  // Um catálogo vazio faria a UI dizer «ainda não há categorias criadas» a
  // quem tem a base por migrar — e mandava essa pessoa clicar num botão que
  // não podia funcionar.
  const catalogoIndisponivel: ExpenseCategoryCatalog = {
    available: false, categories: [], suggestions: [], missingSuggestions: [],
  };

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
        expenseCatalog={categoriesRes.ok ? categoriesRes.catalog : catalogoIndisponivel}
        companyId={profile.company_id}
        error={res.ok ? null : res.error}
      />
    </FinanceShell>
  );
}
