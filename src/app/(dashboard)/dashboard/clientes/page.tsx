import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ClientesTabs } from "./_components/clientes-tabs";
import { CLIENTE_SHEET_SELECT } from "@/lib/cliente-sheet-fields";
import { getBuildingCards } from "@/app/actions/building-cards";

/**
 * `?tab=predios&predio=<id>` — de onde vem, e porquê pelo URL
 *
 * O card «Prédios» do Financeiro liga para aqui em vez de ter formulário
 * próprio. Passar o destino pelo URL faz com que o link seja partilhável e
 * sobreviva a um refresh, o que um estado só em memória não daria.
 *
 * Um `predio` que não exista é ignorado em silêncio: a aba abre na mesma, sem
 * formulário. Um id velho num favorito não deve dar erro a quem clica.
 */
export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; predio?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("auth_user_id", user!.id)
    .single();

  const companyId = me?.company_id ?? "";

  const [{ data: clientes }, { data: teams }, buildingCards] = await Promise.all([
    supabase
      .from("clients")
      .select(CLIENTE_SHEET_SELECT)
      .eq("company_id", companyId)
      .order("name"),
    supabase
      .from("teams")
      .select("id, name, color")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
    getBuildingCards().catch(() => []),
  ]);

  return (
    <div>
      <Header
        title="Clientes"
        subtitle={`${clientes?.length ?? 0} clientes`}
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ClientesTabs
          clientes={(clientes ?? []).map((c) => ({ ...c, vat_exempt: (c as { vat_exempt?: boolean }).vat_exempt ?? false }))}
          buildingCards={buildingCards}
          teams={teams ?? []}
          companyId={companyId}
          initialTab={params.tab === "predios" ? "predios" : "clientes"}
          initialEditBuildingId={
            params.predio && buildingCards.some((c) => c.id === params.predio) ? params.predio : null
          }
        />
      </div>
    </div>
  );
}
