import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { startOfWeek, parseISO } from "date-fns";
import { Header } from "@/components/layout/header";
import { CalendarView } from "./_components/calendar-view";
import { getDemoServices, DEMO_TEAMS } from "./_demo/mock-data";
import type { Database } from "@/types/database";

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];
type Team = { id: string; name: string; color: string };

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

  if (!me || me.role === "colaborador") redirect("/app");

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
    supabase
      .from("services_full")
      .select([
        "id", "company_id", "reference_number", "contract_id", "is_exception",
        "scheduled_start", "scheduled_end", "actual_start", "actual_end",
        "status", "notes", "calculated_value", "manual_value",
        "location_id", "location_name", "location_address",
        "location_lat", "location_lng", "location_has_key", "location_key_label",
        "location_access_code", "location_instructions",
        "client_id", "client_name", "client_phone", "client_email",
        "team_id", "team_name", "team_color",
      ].join(", "))
      .eq("company_id", companyId)
      .gte("scheduled_start", weekStart.toISOString())
      .lt("scheduled_start", weekEndExclusive.toISOString())
      .order("scheduled_start"),
    supabase
      .from("teams")
      .select("id, name, color")
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
  const sortedTeams = [...(teams ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "pt", { numeric: true, sensitivity: "base" })
  );
  const finalTeams  = isDemo ? DEMO_TEAMS : (sortedTeams as Team[]);
  const finalSvcs   = isDemo ? getDemoServices() : (services ?? []) as unknown as ServiceFull[];
  const totalServices = finalSvcs.length;

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
        services={finalSvcs}
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
