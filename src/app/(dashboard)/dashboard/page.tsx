import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { DashboardKPIs } from "./_components/kpis";
import { TodayServices } from "./_components/today-services";
import { AlertsPanel } from "./_components/alerts-panel";
import { formatDate } from "@/lib/utils";

export default async function DashboardPage() {
  const supabase = await createClient();

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

  const [servicesRes, teamsRes] = await Promise.all([
    supabase
      .from("services_full")
      .select("*")
      .gte("scheduled_start", todayStart)
      .lte("scheduled_start", todayEnd)
      .order("scheduled_start"),
    supabase
      .from("teams_with_members")
      .select("id, name, color"),
  ]);

  const services = servicesRes.data ?? [];
  const teams = teamsRes.data ?? [];

  const kpis = {
    total:       services.length,
    done:        services.filter((s) => s.status === "concluido").length,
    ongoing:     services.filter((s) => s.status === "em_curso").length,
    noCoverage:  services.filter((s) => s.status === "sem_cobertura").length,
  };

  const alerts = services.filter(
    (s) => s.status === "sem_cobertura" || s.status === "falta"
  );

  const subtitle = formatDate(today.toISOString());

  return (
    <div>
      <Header title="Dashboard" subtitle={subtitle} />

      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-6 mx-auto max-w-[1400px]">
        <DashboardKPIs kpis={kpis} />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <TodayServices services={services} />
          </div>
          <div>
            <AlertsPanel alerts={alerts} />
          </div>
        </div>
      </div>
    </div>
  );
}
