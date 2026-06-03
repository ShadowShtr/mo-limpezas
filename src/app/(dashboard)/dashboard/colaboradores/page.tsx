import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
    .select("id, full_name, email, phone, role, status, contracted_hours_month, skills, avatar_url, created_at, invited_at, invite_accepted_at")
    .eq("company_id", company?.company_id ?? "")
    .not("role", "eq", "admin")
    .order("full_name");

  return (
    <div>
      <Header
        title="Colaboradores"
        subtitle={`${colaboradores?.length ?? 0} colaboradores`}
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
      <div className="p-6 max-w-[1400px]">
        <ColaboradoresTable colaboradores={colaboradores ?? []} companyId={company?.company_id ?? ""} />
      </div>
    </div>
  );
}
