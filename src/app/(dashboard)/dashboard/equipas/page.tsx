import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { EquipasGrid } from "./_components/grid";
import { EquipaSheet } from "./_components/sheet";
import { Plus, Car } from "lucide-react";

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
  ]);

  const equipas = [...(equipasRes.data ?? [])].sort((a, b) =>
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
