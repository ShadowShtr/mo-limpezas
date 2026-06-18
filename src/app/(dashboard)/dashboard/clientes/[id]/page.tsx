import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { Header } from "@/components/layout/header";
import { CommunicationTab } from "./_components/communication-tab";
import { LocaisTable } from "../../locais/_components/table";
import { LocalSheet } from "../../locais/_components/sheet";

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

  if (!me) redirect("/login");
  if (me.role === "colaborador") redirect("/app");

  const [{ data: client }, { data: notifications }, { data: locaisRaw }] = await Promise.all([
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

    admin
      .from("locations")
      .select("id, name, address, lat, lng, hourly_rate, fixed_price, pricing_type, active, client_id, access_code, has_key, key_label, instructions")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .order("name"),
  ]);

  if (!client) notFound();

  const locais = (locaisRaw ?? []).map((l) => {
    const r = l as typeof l & { fixed_price?: number | null; pricing_type?: string };
    return { ...r, fixed_price: r.fixed_price ?? null, pricing_type: (r.pricing_type ?? "hourly") as "hourly" | "fixed" };
  });
  const clienteRef = [{ id: client.id, name: client.name }];

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

          {/* Locais */}
          <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-[var(--color-text-main)]">
                Locais <span className="text-[var(--color-text-muted)] font-normal">({locais.length})</span>
              </h2>
              <LocalSheet
                companyId={me.company_id}
                clientes={clienteRef}
                fixedClientId={client.id}
                trigger={
                  <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                    <Plus className="w-4 h-4" />
                    Novo local
                  </button>
                }
              />
            </div>
            <LocaisTable
              locais={locais}
              clientes={clienteRef}
              companyId={me.company_id}
            />
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
