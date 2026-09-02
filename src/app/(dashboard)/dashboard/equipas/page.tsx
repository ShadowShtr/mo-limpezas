import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { EquipasGrid } from "./_components/grid";
import { EquipaSheet } from "./_components/sheet";
import { EquipasDiaEfetivo } from "./_components/effective-day";
import { Plus, Car } from "lucide-react";
import { resolverActorEquipas } from "@/lib/equipas/actor";
import { todayInLisbon } from "@/lib/lisbon-time";

function EquipasFailClosed() {
  return (
    <div>
      <Header title="Equipas" subtitle="Não foi possível carregar" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Não foi possível confirmar os dados de Equipas. Nada foi alterado.
          <div className="mt-3">
            <Link
              href="/dashboard/equipas"
              className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Tentar novamente
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function EquipasPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return <EquipasFailClosed />;

  const resolucao = await resolverActorEquipas(admin, user.id);
  if (!resolucao.ok) return <EquipasFailClosed />;

  const companyId = resolucao.actor.companyId;

  const [equipasRes, colaboradoresRes, membershipSnapshotRes] = await Promise.all([
    admin
      .from("teams_with_members")
      .select("*")
      .eq("company_id", companyId),
    admin
      .from("profiles")
      .select("id, full_name, avatar_url, role, status")
      .eq("company_id", companyId)
      .eq("role", "colaborador")
      .eq("status", "ativo")
      .order("full_name"),
    admin.rpc("permanent_membership_snapshot", { p_company_id: companyId }),
  ]);

  if (
    equipasRes.error
    || colaboradoresRes.error
    || membershipSnapshotRes.error
    || typeof membershipSnapshotRes.data !== "string"
    || !Array.isArray(equipasRes.data)
    || !Array.isArray(colaboradoresRes.data)
  ) {
    return <EquipasFailClosed />;
  }

  const equipas = [...equipasRes.data].sort((a, b) =>
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
              companyId={companyId}
              colaboradores={colaboradoresRes.data}
              membershipSnapshot={membershipSnapshotRes.data}
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
        <EquipasDiaEfetivo companyId={companyId} initialDate={todayInLisbon()} />

        <div className="mb-3 mt-7">
          <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Composição permanente</h2>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Esta é a base das equipas. Alterações só de um dia aparecem acima e não mudam silenciosamente esta composição.
          </p>
        </div>

        <EquipasGrid
          equipas={equipas}
          colaboradores={colaboradoresRes.data}
          companyId={companyId}
          membershipSnapshot={membershipSnapshotRes.data}
        />
      </div>
    </div>
  );
}
