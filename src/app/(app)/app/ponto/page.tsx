import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth/current-user";
import { PontoGeral } from "./_components/ponto-geral";

function lisbonDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export default async function PontoPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const workDate = lisbonDate();

  const { data: today } = await supabase
    .from("daily_clocks")
    .select("clock_in_at, clock_out_at")
    .eq("collaborator_id", profile.id)
    .eq("work_date", workDate)
    .maybeSingle();

  return (
    <div className="flex flex-col gap-5 pb-2">
      <div>
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">Ponto do dia</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          Bate o ponto de início para libertar os serviços. O que conta para o salário é o ponto de início e fim.
        </p>
      </div>
      <PontoGeral initial={today ?? null} />
    </div>
  );
}
