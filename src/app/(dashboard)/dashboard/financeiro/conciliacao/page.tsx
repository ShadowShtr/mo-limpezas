import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { getBankReconciliationData } from "@/app/actions/bank-reconciliation";
import { ReconciliationClient } from "./_components/reconciliation-client";

export const metadata = { title: "Conciliação Bancária — Escala" };

export default async function ConciliacaoPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Só admin/gestor — colaborador nunca acede a dados bancários.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile?.company_id) redirect("/login");
  if (!["admin", "gestor"].includes(profile.role)) redirect("/dashboard");

  const res = await getBankReconciliationData();

  return (
    <div>
      <Header title="Conciliação Bancária" subtitle="Importar extratos e cruzar com lançamentos financeiros" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ReconciliationClient
          initial={res.ok ? { transactions: res.transactions, imports: res.imports, accounts: res.accounts } : null}
          error={res.ok ? null : res.error}
        />
      </div>
    </div>
  );
}
