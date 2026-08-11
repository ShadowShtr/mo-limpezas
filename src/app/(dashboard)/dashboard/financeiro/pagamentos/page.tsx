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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 Esta vista está ISOLADA do período do módulo.
  //
  // `getPayments` chama `ensureMonth`, que faz `.insert(rows)`: abrir um mês
  // aqui **gera** os pagamentos fixos desse mês, clonados do mês anterior mais
  // recente. É anterior ao Financeiro V2 e não é corrigido nesta PR — a
  // correcção vive em `payments.ts`, BLOQUEADO_INCIDENTE_FINANCEIRO.
  //
  // O que esta PR garante é **não tornar o gatilho mais fácil de puxar**: a
  // casca não desenha seletor nem setas aqui, e a navegação do módulo não
  // transporta o mês para esta rota. O `?mes` continua a ser lido porque o
  // seletor legado da própria vista o usa — esse é anterior e fica.
  //
  // Ver PERIOD_ISOLATED_VIEWS em `src/components/financeiro/finance-nav.tsx`.
  // ───────────────────────────────────────────────────────────────────────────
  const period = parseFinancePeriod(params.mes);

  const res = await getPayments(period.year, period.month);

  return (
    <FinanceShell
      period={period}
      periodIsolated
      title="Pagamentos"
      subtitle="Fixos e variáveis, com estado de pagamento"
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
