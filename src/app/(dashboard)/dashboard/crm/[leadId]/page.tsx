import { notFound, redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getLead } from "@/app/actions/crm-leads";
import { ACTION_ERROR_CODES } from "@/lib/action-result";

import { LeadDetail } from "./_components/lead-detail";

export default async function LeadPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;

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

  const res = await getLead(leadId);

  if (!res.ok) {
    // Uma lead de outra empresa e uma que não existe dão o mesmo 404, de
    // propósito: confirmar a existência de uma lead alheia já é informação.
    if (res.error.code === ACTION_ERROR_CODES.NOT_FOUND) notFound();
    throw new Error(res.error.message);
  }

  const { data: membros } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("company_id", profile.company_id)
    .in("role", ["admin", "gestor"])
    .eq("status", "ativo")
    .order("full_name");

  return (
    <>
      <Header title={res.data.lead.name} subtitle="Lead" backHref="/dashboard/crm" />
      <div className="mx-auto max-w-[1000px] px-4 py-5 sm:p-6 lg:px-8">
        <LeadDetail
          lead={res.data.lead}
          interactions={res.data.interactions}
          membros={membros ?? []}
        />
      </div>
    </>
  );
}
