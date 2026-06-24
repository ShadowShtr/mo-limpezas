import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ContratosTable } from "./_components/table";
import { ContratoSheet } from "./_components/sheet";
import { Plus } from "lucide-react";

export default async function ContratosPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = me?.company_id ?? "";

  const [{ data: contratos }, { data: clientes }, { data: locais }, { data: equipas }] =
    await Promise.all([
      supabase
        .from("contracts")
        .select(`
          id, name, frequency, interval_days, weekdays, schedule_days,
          starts_on, ends_on, status, notes, created_at,
          cleaning_type, payment_status, upholstery_type, upholstery_notes,
          locations ( id, name, address, hourly_rate, clients ( id, name ) )
        `)
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
      supabase
        .from("clients")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("status", "ativo")
        .order("name"),
      supabase
        .from("locations")
        .select("id, client_id, name, address, hourly_rate, access_code, instructions, has_key, key_label")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),
      supabase
        .from("teams")
        .select("id, name, color")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),
    ]);

  return (
    <div>
      <Header
        title="Contratos"
        subtitle={`${contratos?.length ?? 0} contratos`}
        actions={
          <ContratoSheet
            companyId={companyId}
            userId={user!.id}
            clientes={clientes ?? []}
            locais={locais ?? []}
            equipas={equipas ?? []}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Novo contrato
              </button>
            }
          />
        }
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ContratosTable
          contratos={(contratos ?? []) as unknown as ContratosTableRow[]}
          companyId={companyId}
          userId={user!.id}
          clientes={clientes ?? []}
          locais={locais ?? []}
          equipas={equipas ?? []}
        />
      </div>
    </div>
  );
}

export type ContratosTableRow = {
  id: string;
  name: string | null;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: import("@/types/database").ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  status: string;
  notes: string | null;
  cleaning_type: string | null;
  payment_status: string | null;
  upholstery_type: string | null;
  upholstery_notes: string | null;
  created_at: string;
  locations: {
    id: string;
    name: string;
    address: string;
    hourly_rate: number | null;
    clients: { id: string; name: string } | null;
  } | null;
};
