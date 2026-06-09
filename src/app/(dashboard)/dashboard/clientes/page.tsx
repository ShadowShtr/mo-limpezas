import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ClientesTable } from "./_components/table";
import { ClienteSheet } from "./_components/sheet";
import { Plus, MapPin } from "lucide-react";

export default async function ClientesPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const { data: clientes } = await supabase
    .from("clients")
    .select("id, name, email, phone, nif, status, vat_exempt, created_at")
    .order("name");

  return (
    <div>
      <Header
        title="Clientes"
        subtitle={`${clientes?.length ?? 0} clientes`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/locais"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <MapPin className="w-4 h-4" />
              Locais
            </Link>
            <ClienteSheet
              companyId={me?.company_id ?? ""}
              trigger={
                <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                  <Plus className="w-4 h-4" />
                  Novo cliente
                </button>
              }
            />
          </div>
        }
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ClientesTable
          clientes={(clientes ?? []).map((c) => ({ ...c, vat_exempt: (c as { vat_exempt?: boolean }).vat_exempt ?? false }))}
          companyId={me?.company_id ?? ""}
        />
      </div>
    </div>
  );
}
