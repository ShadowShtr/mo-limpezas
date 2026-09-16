import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { CrmNav } from "@/components/crm/crm-nav";
import { getQuotes } from "@/app/actions/crm-orcamentos";
import { getLeads } from "@/app/actions/crm-leads";
import { todayInLisbon } from "@/lib/lisbon-time";

import { QuotesClient } from "./_components/quotes-client";

export default async function OrcamentosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.company_id) redirect("/login");
  if (!["admin", "gestor"].includes(profile.role)) redirect("/app");

  const [quotesRes, leadsRes, { data: settings }] = await Promise.all([
    getQuotes(),
    getLeads(),
    admin
      .from("company_settings")
      .select("vat_rate")
      .eq("company_id", profile.company_id)
      .maybeSingle(),
  ]);

  return (
    <>
      <Header title="CRM" subtitle="Orçamentos" />
      <div className="mx-auto max-w-[1400px] px-4 py-5 sm:p-6 lg:px-8">
        <CrmNav />
        <div className="mt-5">
          <QuotesClient
            orcamentos={quotesRes.ok ? quotesRes.data : null}
            erro={quotesRes.ok ? null : quotesRes.error.message}
            leads={leadsRes.ok ? leadsRes.data : []}
            // 🔴 `null` quando não se conseguiu ler, e não 23. O formulário
            //    avisa e não deixa criar; assumir a taxa portuguesa corrente
            //    faria uma consulta falhada parecer uma configuração real — e
            //    o valor ficaria gravado no documento.
            vatRate={
              typeof (settings as { vat_rate?: number } | null)?.vat_rate === "number"
                ? (settings as { vat_rate: number }).vat_rate
                : null
            }
            // 🔴 O "hoje" é calculado no servidor com o fuso de Lisboa. Deixá-lo
            //    ao relógio do browser faria um orçamento parecer expirado (ou
            //    não) consoante o fuso de quem está a ver.
            hoje={todayInLisbon()}
          />
        </div>
      </div>
    </>
  );
}
