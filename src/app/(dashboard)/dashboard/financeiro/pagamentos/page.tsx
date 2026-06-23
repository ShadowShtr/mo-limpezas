import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getPayments } from "@/app/actions/payments";
import { PaymentsClient } from "./_components/payments-client";

export const metadata = { title: "Pagamentos Fixos e Variáveis — Escala" };

export default async function PagamentosPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const now = new Date();
  const mesParam = params.mes ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [yearStr, monthStr] = mesParam.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);

  const res = await getPayments(year, month);

  return (
    <div>
      <Header title="Pagamentos Fixos e Variáveis" subtitle="Lembrete do que há a pagar e respetivo estado" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <PaymentsClient
          initialData={res.ok ? res.data : null}
          error={res.ok ? null : res.error}
          mesParam={mesParam}
          year={year}
          month={month}
        />
      </div>
    </div>
  );
}
