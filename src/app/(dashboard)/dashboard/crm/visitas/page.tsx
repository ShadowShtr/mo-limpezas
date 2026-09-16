import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { CrmNav } from "@/components/crm/crm-nav";
import { getVisits } from "@/app/actions/crm-visitas";
import { getLeads } from "@/app/actions/crm-leads";

import { VisitsClient } from "./_components/visits-client";

/**
 * A agenda de visitas comerciais.
 *
 * 🔴 Não é o calendário operacional, e não escreve nele. O calendário é a
 *    agenda do trabalho executado; esta é a agenda de quem vai ver e orçar.
 *    A migration 102 explica por extenso porque é que as duas não se misturam.
 */
export default async function VisitasPage() {
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

  const [visitsRes, leadsRes, { data: membros }] = await Promise.all([
    getVisits(),
    getLeads(),
    admin
      .from("profiles")
      .select("id, full_name")
      .eq("company_id", profile.company_id)
      .in("role", ["admin", "gestor"])
      .eq("status", "ativo")
      .order("full_name"),
  ]);

  return (
    <>
      <Header title="CRM" subtitle="Visitas comerciais" />
      <div className="mx-auto max-w-[1400px] px-4 py-5 sm:p-6 lg:px-8">
        <CrmNav />
        <div className="mt-5">
          <VisitsClient
            visitas={visitsRes.ok ? visitsRes.data : null}
            erro={visitsRes.ok ? null : visitsRes.error.message}
            leads={leadsRes.ok ? leadsRes.data : []}
            membros={membros ?? []}
          />
        </div>
      </div>
    </>
  );
}
