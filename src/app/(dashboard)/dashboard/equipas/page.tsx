import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { EquipasGrid } from "./_components/grid";
import { EquipaSheet } from "./_components/sheet";
import { Plus, Car } from "lucide-react";
import { logQueryFailure } from "@/lib/query-error";

export default async function EquipasPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const [equipasRes, colaboradoresRes, teamVersionsRes] = await Promise.all([
    admin
      .from("teams_with_members")
      .select("*")
      .eq("company_id", me?.company_id ?? ""),
    admin
      .from("profiles")
      .select("id, full_name, avatar_url, role, status")
      .eq("company_id", me?.company_id ?? "")
      .eq("role", "colaborador")
      .eq("status", "ativo")
      .order("full_name"),
    admin
      .from("teams")
      .select("id, updated_at")
      .eq("company_id", me?.company_id ?? ""),
  ]);

  if (equipasRes.error || colaboradoresRes.error || teamVersionsRes.error) {
    if (equipasRes.error) logQueryFailure("EquipasPage:teams", equipasRes.error);
    if (colaboradoresRes.error) logQueryFailure("EquipasPage:profiles", colaboradoresRes.error);
    if (teamVersionsRes.error) logQueryFailure("EquipasPage:versions", teamVersionsRes.error);
    throw new Error("Não foi possível carregar as equipas.");
  }

  const versions = new Map((teamVersionsRes.data ?? []).map((team) => [team.id, team.updated_at]));
  const equipas = [...(equipasRes.data ?? [])]
    .map((team) => ({ ...team, updated_at: versions.get(team.id) ?? "" }))
    .sort((a, b) =>
    (a.name as string).localeCompare(b.name as string, "pt", { numeric: true, sensitivity: "base" })
  );

  return (
    <div>
      <Header
        title="Equipas"
        subtitle={`${equipas.length} equipas`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/viaturas"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Car className="w-4 h-4" />
              Viaturas
            </Link>
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
          </div>
        }
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <EquipasGrid
          equipas={equipas}
          colaboradores={colaboradoresRes.data ?? []}
          companyId={me?.company_id ?? ""}
        />
      </div>
    </div>
  );
}
