import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getCompanySettings } from "@/app/actions/settings";
import { SettingsForm } from "./_components/settings-form";
import { SeedButton } from "./_components/seed-button";
import { CsvImport } from "./_components/csv-import";
import { BackupSection } from "./_components/backup-section";

export default async function ConfiguracoesPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user!.id)
    .single();

  const companyId = profile?.company_id ?? "";
  const settings = await getCompanySettings(companyId);

  return (
    <div>
      <Header
        title="Configurações"
        subtitle="Valores e percentagens que afetam cálculos em toda a plataforma"
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-6 mx-auto max-w-[900px]">
        <a href="/dashboard/sistema/auditoria"
          className="block rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 hover:bg-[var(--color-background)] transition-colors">
          <span className="text-sm font-semibold text-[var(--color-text-main)]">Auditoria de Alterações →</span>
          <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">
            Histórico de tudo o que mudou (clientes, contratos, serviços, valores) com botão para restaurar valores anteriores.
          </span>
        </a>
        <a href="/dashboard/sistema/diagnostico"
          className="block rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 hover:bg-[var(--color-background)] transition-colors">
          <span className="text-sm font-semibold text-[var(--color-text-main)]">Diagnóstico do Sistema →</span>
          <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">
            Confirma que este dispositivo fala com o commit, ambiente e projeto Supabase corretos, e se o banco tem a migration que o código espera.
          </span>
        </a>
        <BackupSection />
        <SettingsForm initial={settings} />
        <CsvImport />
        <SeedButton />
      </div>
    </div>
  );
}
