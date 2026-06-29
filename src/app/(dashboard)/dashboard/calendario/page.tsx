import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { startOfWeek, parseISO } from "date-fns";
import { Header } from "@/components/layout/header";
import { CalendarView } from "./_components/calendar-view";
import type { ServiceCalendar } from "./_components/calendar-view";
import { getDemoServices, DEMO_TEAMS } from "./_demo/mock-data";
import type { Database } from "@/types/database";

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team = { id: string; name: string; color: string; member_count?: number };

export default async function CalendarioPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
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

  const companyId = me.company_id;

  const params = await searchParams;
  const baseDate = params.date ? parseISO(params.date) : new Date();
  const weekStart = startOfWeek(baseDate, { weekStartsOn: 1 });
  const weekEndExclusive = new Date(weekStart);
  weekEndExclusive.setDate(weekEndExclusive.getDate() + 7);

  const [
    { data: services },
    { data: teams },
    { data: clients },
    { data: locations },
  ] = await Promise.all([
    // Página só de gestores: lê via `admin` para garantir que TODOS os serviços
    // registados aparecem. A view services_full é security_invoker e o JOIN com
    // locations/clients sob RLS pode esconder linhas da sessão autenticada,
    // fazendo um serviço sumir do calendário apesar de estar no contrato.
    admin
      .from("services_full")
      .select([
        "id", "company_id", "reference_number", "contract_id", "is_exception",
        "scheduled_start", "scheduled_end", "actual_start", "actual_end",
        "status", "notes", "calculated_value", "manual_value",
        "location_id", "location_name", "location_address",
        "location_lat", "location_lng", "location_has_key", "location_key_label",
        "location_access_code",
        "client_id", "client_name",
        "team_id", "team_name", "team_color",
      ].join(", "))
      .eq("company_id", companyId)
      .gte("scheduled_start", weekStart.toISOString())
      .lt("scheduled_start", weekEndExclusive.toISOString())
      .order("scheduled_start"),
    // Via `admin`: o RLS sobre team_members filtra os membros quando lido pela
    // sessão autenticada, devolvendo `members` vazio → member_count caía para 0
    // e o nº de pessoas assumia sempre 1. Com admin o tamanho da equipa é real.
    admin
      .from("teams_with_members")
      .select("id, name, color, members")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
    supabase
      .from("clients")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("status", "ativo")
      .order("name"),
    supabase
      .from("locations")
      .select("id, client_id, name, address, hourly_rate")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
  ]);

  // Modo de demonstração: usar dados de exemplo quando não há equipas configuradas
  const isDemo = !teams || teams.length === 0;
  const teamsWithCount = (teams ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    color: t.color as string,
    member_count: Array.isArray(t.members) ? t.members.length : 0,
  }));
  const sortedTeams = teamsWithCount.sort((a, b) =>
    a.name.localeCompare(b.name, "pt", { numeric: true, sensitivity: "base" })
  );
  const finalTeams  = isDemo ? DEMO_TEAMS : (sortedTeams as Team[]);
  const rawSvcs     = isDemo ? getDemoServices() : (services ?? []) as unknown as ServiceFull[];
  const totalServices = rawSvcs.length;

  // Converter para ServiceCalendar: computar boolean e strip de campos sensíveis.
  // O RSC recebe location_access_code para derivar o boolean, mas não o serializa para o browser.
  const processedServices: ServiceCalendar[] = rawSvcs.map((s) => {
    // Destructuring remove campos sensíveis de `rest` (não serializados para o browser).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { location_access_code, location_instructions, client_phone, client_email, ...rest } =
      s as ServiceFull & { location_access_code?: string | null; location_instructions?: string | null; client_phone?: string | null; client_email?: string | null };
    return {
      ...rest,
      location_has_access_code: !!(location_access_code),
      location_access_code: null,
      location_instructions: null,
      client_phone: null,
      client_email: null,
    } as ServiceCalendar;
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header
        title="Calendário"
        subtitle={
          isDemo
            ? `Modo de demonstração — ${totalServices} serviços de exemplo`
            : `${totalServices} serviço${totalServices !== 1 ? "s" : ""} esta semana`
        }
      />
      <CalendarView
        services={processedServices}
        teams={finalTeams}
        weekStartISO={weekStart.toISOString()}
        selectedDateISO={baseDate.toISOString()}
        companyId={companyId}
        clients={clients ?? []}
        locations={locations ?? []}
        isDemo={isDemo}
      />
    </div>
  );
}
