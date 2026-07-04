import Link from "next/link";
import { Bell, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { DashboardKPIs } from "./_components/kpis";
import { TodayServices } from "./_components/today-services";
import { AlertsPanel } from "./_components/alerts-panel";
import { DocumentsBackupBanner } from "./_components/documents-backup-banner";
import { BackupReminder } from "./_components/backup-reminder";
import { PaymentsReminderBanner } from "./_components/payments-reminder-banner";
import { formatDate } from "@/lib/utils";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

  const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const [servicesRes, expiringDocsRes] = await Promise.all([
    supabase
      .from("services_full")
      .select("*")
      .eq("company_id", profile.company_id)
      .gte("scheduled_start", todayStart)
      .lte("scheduled_start", todayEnd)
      .order("scheduled_start"),
    admin
      .from("collaborator_documents")
      .select("id", { count: "exact", head: true })
      .eq("company_id", profile.company_id)
      .is("archived_at", null)
      .gt("expires_at", today.toISOString())
      .lt("expires_at", thirtyDaysFromNow),
  ]);

  const services     = servicesRes.data ?? [];
  const expiringDocs = expiringDocsRes.count ?? 0;

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
        <BackupReminder />
        <PaymentsReminderBanner />
        <DocumentsBackupBanner expiringCount={expiringDocs} />

        {/* Pendências vivem dentro do Dashboard (saíram do menu lateral) */}
        <Link
          href="/dashboard/pendencias"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
            <Bell className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Pendências</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              Serviços sem checkout, pontos fora do raio, fotos falhadas e mais
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)]" />
        </Link>

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
