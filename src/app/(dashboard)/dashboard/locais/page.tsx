import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { LocaisTable } from "./_components/table";
import { LocalSheet } from "./_components/sheet";
import { Plus } from "lucide-react";

export default async function LocaisPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const [locaisRes, clientesRes] = await Promise.all([
    supabase
      .from("locations")
      .select("id, name, address, lat, lng, hourly_rate, active, client_id, access_code")
      .order("name"),
    supabase
      .from("clients")
      .select("id, name")
      .eq("status", "ativo")
      .order("name"),
  ]);

  const locais = locaisRes.data;
  const clientes = clientesRes.data;

  return (
    <div>
      <Header
        title="Locais"
        subtitle={`${locais?.length ?? 0} locais`}
        actions={
          <LocalSheet
            companyId={me?.company_id ?? ""}
            clientes={clientes ?? []}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Novo local
              </button>
            }
          />
        }
      />
      <div className="p-6 max-w-[1400px]">
        <LocaisTable locais={locais ?? []} clientes={clientes ?? []} companyId={me?.company_id ?? ""} />
      </div>
    </div>
  );
}
