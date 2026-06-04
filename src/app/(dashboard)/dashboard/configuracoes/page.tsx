import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getCompanySettings } from "@/app/actions/settings";
import { SettingsForm } from "./_components/settings-form";
import { SeedButton } from "./_components/seed-button";

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
      <div className="p-6 max-w-[900px] space-y-6">
        <SettingsForm initial={settings} />
        <SeedButton />
      </div>
    </div>
  );
}
