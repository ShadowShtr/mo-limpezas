import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { CrmNav } from "@/components/crm/crm-nav";
import { getLeads } from "@/app/actions/crm-leads";

import { PipelineClient } from "./_components/pipeline-client";

/**
 * O funil comercial.
 *
 * 🔴 Esta página só lê. A materialização de estado a meio de um render é o que
 *    rebentou a Folha de Pagamento em 2026-07-06 (uma action com
 *    `revalidatePath` chamada durante o render de um Server Component). Aqui
 *    não há nada a criar: se não houver leads, mostra-se o vazio.
 */
export default async function CrmPage() {
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
  // O funil é de quem gere. A app das colaboradoras vive noutro sítio.
  if (!["admin", "gestor"].includes(profile.role)) redirect("/app");

  const [leadsRes, { data: membros }] = await Promise.all([
    getLeads(),
    admin
      .from("profiles")
      .select("id, full_name")
      .eq("company_id", profile.company_id)
      .in("role", ["admin", "gestor"])
      .eq("status", "ativo")
      .order("full_name"),
  ]);

  // Uma falha de leitura não é uma lista vazia. Mostrar zero leads quando a
  // consulta falhou faria alguém pensar que perdeu o funil todo.
  const leads = leadsRes.ok ? leadsRes.data : null;

  return (
    <>
      <Header
        title="CRM"
        subtitle="Do primeiro contacto até ao cliente"
      />
      <div className="mx-auto max-w-[1400px] px-4 py-5 sm:p-6 lg:px-8">
        <CrmNav />
        <div className="mt-5">
          <PipelineClient
            leads={leads}
            erro={leadsRes.ok ? null : leadsRes.error.message}
            membros={membros ?? []}
          />
        </div>
      </div>
    </>
  );
}
