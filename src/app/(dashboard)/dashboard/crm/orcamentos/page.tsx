import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { CrmNav } from "@/components/crm/crm-nav";
import { getQuotes } from "@/app/actions/crm-orcamentos";
import { getVisits } from "@/app/actions/crm-visitas";
import { getLeads } from "@/app/actions/crm-leads";
import { addDaysToDateString, todayInLisbon } from "@/lib/lisbon-time";

import { QuotesClient } from "./_components/quotes-client";

/**
 * Os orçamentos comerciais.
 *
 * 🔴 Um orçamento NÃO é documento fiscal. Não entra em `invoices`, não gera
 *    movimento de caixa e não participa no protocolo de período financeiro —
 *    orçamentar num mês fechado é legítimo. O comentário da tabela na 103
 *    diz-o por extenso, e é a fronteira que mantém este ecrã fora do
 *    orçamento de escrita financeira.
 *
 * 🔴 O envio por email e a conversão em cliente NÃO estão aqui: são a 103-B2 e
 *    a 104-A, cada uma com a sua autorização. Este ciclo fecha o documento —
 *    criar, ver, imprimir, marcar o estado e revir.
 */
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

  // As visitas do último ano, e não só as futuras: uma visita serve um
  // orçamento DEPOIS de ter sido realizada — é dela que saem as medidas.
  const desdeUmAno = `${addDaysToDateString(todayInLisbon(), -365)}T00:00:00.000Z`;

  const [
    quotesRes,
    leadsRes,
    visitsRes,
    { data: clientes },
    { data: empresa },
    { data: settings },
  ] = await Promise.all([
    getQuotes(),
    getLeads(),
    getVisits({ desde: desdeUmAno }),
    admin
      .from("clients")
      .select("id, name")
      .eq("company_id", profile.company_id)
      .eq("status", "ativo")
      .order("name"),
    admin.from("companies").select("name").eq("id", profile.company_id).maybeSingle(),
    // 🔴 A taxa de IVA serve SÓ para a pré-visualização dos totais enquanto se
    //    escreve. O valor que vale é o que a RPC grava, com a taxa que ELA lê
    //    do servidor — este número nunca viaja de volta numa escrita.
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
            clientes={clientes ?? []}
            visitas={visitsRes.ok ? visitsRes.data : []}
            empresaNome={empresa?.name ?? "Mó Limpezas"}
            vatRate={settings?.vat_rate ?? null}
          />
        </div>
      </div>
    </>
  );
}
