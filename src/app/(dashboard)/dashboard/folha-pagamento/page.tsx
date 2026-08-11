import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
import { getPayrollRecords } from "@/app/actions/payroll";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod, formatFinancePeriod } from "@/lib/finance-period";
import { PayrollClient } from "./_components/payroll-client";

export const metadata = { title: "Folha de Pagamento — Escala" };

interface SearchParams { mes?: string }

export default async function FolhaPagamentoPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = profile?.company_id ?? "";

  const period = parseFinancePeriod(params.mes);
  const { year, month } = period;

  const result = await getPayrollRecords(companyId, year, month);
  const records = result.ok ? result.records : [];

  const { count: activePayrollProfiles } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .in("role", ["colaborador", "gestor", "admin"]);

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 Financeiro V2 (PR A) — o render deixou de escrever.
  //
  // Aqui estava:
  //
  //     if (activePayrollProfiles && records.length < activePayrollProfiles) {
  //       const refreshed = await ensurePayrollCalculated(year, month);
  //       records = refreshed.ok ? refreshed.records : records;
  //     }
  //
  // `ensurePayrollCalculated` delega em `runPayrollCalculation`, que faz
  // `.upsert(payroll_records)` (payroll.ts:201). Ou seja: **abrir a página
  // gravava**. Com a navegação nova, isso passaria a acontecer só por clicar
  // numa aba ou mudar de mês — e a regra do módulo é que navegar e visualizar
  // são read-only.
  //
  // O cálculo não desapareceu: passou a ser accionado pelo botão
  // "Recalcular folha", que já existia e chama `calculateAndSavePayroll`. A
  // página apenas informa que a folha está por calcular.
  //
  // O motor não foi tocado: `runPayrollCalculation`, `calculateAndSavePayroll`,
  // `approvePayrollRecords`, `markPayrollPaid` e `adjustPayrollRecord` ficam
  // exactamente como estavam.
  // ───────────────────────────────────────────────────────────────────────────
  const expectedRecords = activePayrollProfiles ?? 0;
  const needsCalculation = expectedRecords > 0 && records.length < expectedRecords;

  return (
    <FinanceShell
      period={period}
      title="Folha de Pagamento"
      subtitle="Custo salarial do período, aprovações e pagamentos"
    >
      <PayrollClient
        initialRecords={records}
        companyId={companyId}
        mesParam={period.key}
        year={year}
        month={month}
        mesLabel={formatFinancePeriod(period)}
        needsCalculation={needsCalculation}
        expectedRecords={expectedRecords}
      />
    </FinanceShell>
  );
}
