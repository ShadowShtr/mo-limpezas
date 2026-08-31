import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getInvoices, getUnbilledServices } from "@/app/actions/invoices";
import { getDailyBilling } from "@/app/actions/daily-billing";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod, formatFinancePeriod } from "@/lib/finance-period";
import { todayInLisbon } from "@/lib/lisbon-time";
import { CobrancasTabs } from "./_components/cobrancas-tabs";

export const metadata = { title: "Cobranças — Escala" };

interface SearchParams { mes?: string; cliente?: string }

export default async function CobrancastPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params   = await searchParams;
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
  // A cobrança diária continua ancorada em HOJE, não no período do módulo:
  // é uma vista operacional do dia, não do mês. Trocar isso seria mudar
  // semântica, e este PR não muda nenhuma.
  const todayStr = todayInLisbon();

  // 🔴 As três listas que o `ServiceCreateSheet` precisa para criar um serviço
  //    SEM sair do Diário.
  //
  //    A versão anterior deste CTA mandava o utilizador para o calendário no
  //    dia certo. Chegava lá — mas «adicionar cobrança» passava a ser uma
  //    viagem, e quem está a fechar o dia perdia o contexto do que estava a
  //    fazer. O formulário vem ter com a pessoa, e é o MESMO componente que o
  //    calendário e a ficha de cliente já usam: um caminho de criação, não
  //    três cópias dele.
  //
  //    Lidas pelo service-role, como as outras: sob RLS, `locations`/`clients`
  //    podem esconder linhas da sessão, e um selector meio vazio é pior do que
  //    nenhum. O `company_id` continua a vir do perfil autenticado.
  const [result, unbilledResult, dailyResult, clientsRaw, locationsRaw, teamsRaw] = await Promise.all([
    getInvoices(companyId, period.year, period.month),
    getUnbilledServices(companyId),
    getDailyBilling(todayStr),
    admin
      .from("clients")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("status", "ativo")
      .order("name"),
    admin
      .from("locations")
      .select("id, name, address, client_id, hourly_rate, fixed_price, pricing_type, active")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
    admin
      .from("teams_with_members")
      .select("id, name, color, members")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
  ]);
  const invoices         = result.ok ? result.invoices : [];
  const unbilledServices = unbilledResult.ok ? unbilledResult.services : [];
  const clients   = clientsRaw.data ?? [];
  const locations = locationsRaw.data ?? [];
  const teams = (teamsRaw.data ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    color: t.color as string,
    member_count: Array.isArray(t.members) ? t.members.length : 0,
  }));

  return (
    <FinanceShell
      period={period}
      title="Cobranças"
      subtitle="Controlo diário e faturas do período"
    >
      <CobrancasTabs
        initialInvoices={invoices}
        unbilledServices={unbilledServices}
        companyId={companyId}
        clienteInicial={params.cliente}
        mesParam={period.key}
        year={period.year}
        month={period.month}
        mesLabel={formatFinancePeriod(period)}
        dailyDate={todayStr}
        dailyData={dailyResult.ok ? dailyResult.data : null}
        dailyError={dailyResult.ok ? null : dailyResult.error}
        clients={clients}
        locations={locations}
        teams={teams}
      />
    </FinanceShell>
  );
}
