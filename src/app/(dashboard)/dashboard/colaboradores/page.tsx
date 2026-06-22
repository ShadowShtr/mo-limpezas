import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
import { Header } from "@/components/layout/header";
import { ColaboradoresTable } from "./_components/table";
import { ColaboradorSheet } from "./_components/sheet";
import { UserPlus } from "lucide-react";

export default async function ColaboradoresPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: company } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const { data: colaboradores } = await admin
    .from("profiles")
    .select("id, full_name, email, phone, role, status, contracted_hours_month, skills, avatar_url, created_at, invited_at, invite_accepted_at, nif, iban, hourly_rate, contract_start, contract_end")
    .eq("company_id", company?.company_id ?? "")
    .order("full_name");

  const sortedColaboradores = [...(colaboradores ?? [])].sort((a, b) => {
    const roleOrder: Record<string, number> = { admin: 0, gestor: 1, colaborador: 2 };
    const roleDiff = (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
    return roleDiff || a.full_name.localeCompare(b.full_name, "pt-PT");
  });
  const colaboradoresCount = sortedColaboradores.filter((c) => c.role === "colaborador").length;
  const administracaoCount = sortedColaboradores.length - colaboradoresCount;

  return (
    <div>
      <Header
        title="Colaboradores"
        subtitle={`${colaboradoresCount} colaboradores + ${administracaoCount} administração`}
        actions={
          <ColaboradorSheet
            companyId={company?.company_id ?? ""}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <UserPlus className="w-4 h-4" />
                Convidar
              </button>
            }
          />
        }
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ColaboradoresTable
          colaboradores={sortedColaboradores.map((c) => {
            const r = c as typeof c & { nif?: string | null; iban?: string | null; hourly_rate?: number | null; contract_start?: string | null; contract_end?: string | null };
            return { ...r, nif: r.nif ?? null, iban: r.iban ?? null, hourly_rate: r.hourly_rate ?? null, contract_start: r.contract_start ?? null, contract_end: r.contract_end ?? null };
          })}
          companyId={company?.company_id ?? ""}
        />
      </div>
    </div>
  );
}
