import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getCompanySettings } from "@/app/actions/settings";
import { SettingsForm } from "./_components/settings-form";
import { CsvImport } from "./_components/csv-import";
import { BackupSection } from "./_components/backup-section";
import { isPlatformAdmin } from "@/app/actions/update-notices";

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

  // 🔴 Administração ACIMA do tenant. `profile.role === "admin"` não serve:
  //    esta empresa tem quatro administradoras, e publicar avisos para várias
  //    empresas é outro poder. Esconder o cartão também não é autorização — a
  //    rota e as actions recusam de forma independente.
  const podeGerirAvisos = await isPlatformAdmin();

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
        {podeGerirAvisos && (
          <a href="/dashboard/admin/atualizacoes"
            className="block rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 hover:bg-[var(--color-background)] transition-colors">
            <span className="text-sm font-semibold text-[var(--color-text-main)]">Avisos de Atualização →</span>
            <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">
              Publicar avisos que aparecem a quem entra na aplicação. Cada pessoa confirma o seu, uma vez.
            </span>
          </a>
        )}
        <BackupSection />
        <SettingsForm initial={settings} />
        <CsvImport />
      </div>
    </div>
  );
}
