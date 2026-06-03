import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { EquipasGrid } from "./_components/grid";
import { EquipaSheet } from "./_components/sheet";
import { Plus } from "lucide-react";

export default async function EquipasPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const [equipasRes, colaboradoresRes] = await Promise.all([
    supabase
      .from("teams_with_members")
      .select("*")
      .eq("company_id", me?.company_id ?? "")
      .order("name"),
    admin
      .from("profiles")
      .select("id, full_name, avatar_url, role, status")
      .eq("company_id", me?.company_id ?? "")
      .eq("role", "colaborador")
      .eq("status", "ativo")
      .order("full_name"),
  ]);

  return (
    <div>
      <Header
        title="Equipas"
        subtitle={`${equipasRes.data?.length ?? 0} equipas`}
        actions={
          <EquipaSheet
            companyId={me?.company_id ?? ""}
            colaboradores={colaboradoresRes.data ?? []}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Nova equipa
              </button>
            }
          />
        }
      />
      <div className="p-6 max-w-[1400px]">
        <EquipasGrid
          equipas={equipasRes.data ?? []}
          colaboradores={colaboradoresRes.data ?? []}
          companyId={me?.company_id ?? ""}
        />
      </div>
    </div>
  );
}
