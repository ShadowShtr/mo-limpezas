import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ContratosTable } from "./_components/table";
import { ContratoSheet } from "./_components/sheet";
import { Plus } from "lucide-react";
import { CONTRATO_SHEET_SELECT, type ContratosTableRow } from "@/lib/contrato-sheet-fields";

export type { ContratosTableRow };

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

  const [{ data: contratos }, { data: clientes }, { data: locais }, { data: equipas }, { data: settings }] =
    await Promise.all([
      supabase
        .from("contracts")
        .select(CONTRATO_SHEET_SELECT)
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
        .from("teams_with_members")
        .select("id, name, color, members")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),
      admin
        .from("company_settings")
        .select("vat_rate")
        .eq("company_id", companyId)
        .single(),
    ]);

  const vatRate = settings?.vat_rate ?? 23;

  const equipasComContagem = (equipas ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    member_count: Array.isArray(t.members) ? t.members.length : 0,
  }));

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
            equipas={equipasComContagem}
            vatRate={vatRate}
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
          equipas={equipasComContagem}
          vatRate={vatRate}
        />
      </div>
    </div>
  );
}

