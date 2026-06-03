import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { startOfWeek, parseISO } from "date-fns";
import { Header } from "@/components/layout/header";
import { CalendarView } from "./_components/calendar-view";
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
      .select("*")
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
      .eq("active", true)
      .order("name"),
    supabase
      .from("locations")
      .select("id, client_id, name, address, hourly_rate")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name"),
  ]);

  const totalServices = services?.length ?? 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header
        title="Calendário"
        subtitle={`${totalServices} serviço${totalServices !== 1 ? "s" : ""} esta semana`}
      />
      <CalendarView
        services={(services ?? []) as ServiceFull[]}
        teams={(teams ?? []) as Team[]}
        weekStartISO={weekStart.toISOString()}
        selectedDateISO={baseDate.toISOString()}
        companyId={companyId}
        userId={user.id}
        clients={clients ?? []}
        locations={locations ?? []}
      />
    </div>
  );
}
