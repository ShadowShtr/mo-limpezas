import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Header } from "@/components/layout/header";
import { CommunicationTab } from "./_components/communication-tab";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || me.role === "colaborador") redirect("/dashboard");

  const [{ data: client }, { data: notifications }] = await Promise.all([
    admin
      .from("clients")
      .select("id, name, email, phone, nif, notes, status")
      .eq("id", id)
      .eq("company_id", me.company_id)
      .single(),

    admin
      .from("client_notifications")
      .select("id, method, status, sent_at, message_body, contact_used, created_at")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (!client) notFound();

  return (
    <div className="flex flex-col h-full">
      <Header
        title={client.name}
        subtitle="Ficha do cliente"
        backHref="/dashboard/clientes"
      />
      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">

          {/* Informações gerais */}
          <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
            <h2 className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Informações</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                { label: "Email",    value: client.email },
                { label: "Telefone", value: client.phone },
                { label: "NIF",      value: client.nif },
              ].map(({ label, value }) => value ? (
                <div key={label}>
                  <dt className="text-xs text-[var(--color-text-muted)] mb-0.5">{label}</dt>
                  <dd className="text-[var(--color-text-main)] font-medium">{value}</dd>
                </div>
              ) : null)}
              {client.notes && (
                <div className="col-span-2">
                  <dt className="text-xs text-[var(--color-text-muted)] mb-0.5">Notas</dt>
                  <dd className="text-[var(--color-text-sub)]">{client.notes}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Comunicação */}
          <CommunicationTab
            client={client}
            notifications={notifications ?? []}
          />
        </div>
      </div>
    </div>
  );
}
