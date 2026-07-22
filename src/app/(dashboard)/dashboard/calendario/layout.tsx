import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { CalendarStaticDataProvider } from "./_components/calendar-static-data-context";

// Clientes e locais (~930 linhas cada nesta empresa) não dependem do dia/
// semana selecionado no calendário — só servem para preencher os selects do
// "Novo serviço". Antes, page.tsx buscava-os de novo em TODA navegação (seta
// de semana, escolher dia, month picker), sendo a maior causa do delay ao
// navegar. Um layout só corre uma vez ao entrar na rota — trocar de dia só
// re-renderiza page.tsx, não este layout — por isso ficam aqui.
export default async function CalendarioLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) redirect("/app");

  const [{ data: clients }, { data: locations }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name")
      .eq("company_id", me.company_id)
      .eq("status", "ativo")
      .order("name"),
    supabase
      .from("locations")
      .select("id, client_id, name, address, hourly_rate")
      .eq("company_id", me.company_id)
      .eq("active", true)
      .order("name"),
  ]);

  return (
    <CalendarStaticDataProvider clients={clients ?? []} locations={locations ?? []}>
      {children}
    </CalendarStaticDataProvider>
  );
}
