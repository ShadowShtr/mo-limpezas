import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { dailyContractedMinutes, isAbsentOn } from "@/lib/ponto-calc";
import { todayInLisbon, addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import { RegistoPontoClient, type PontoRow } from "./_components/registo-ponto-client";
import { PontoTabs } from "./_components/ponto-tabs";

export const metadata = { title: "Registo de Ponto — Mó Limpezas" };

/** Lista de dias YYYY-MM-DD entre from e to (inclusive), com limite de segurança. */
function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  for (let i = 0; cursor <= to && i < 92; i++) {
    days.push(cursor);
    cursor = addDaysToDateString(cursor, 1);
  }
  return days;
}

export default async function RegistoPontoPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; collab?: string }>;
}) {
  const sp = await searchParams;
  const from = sp.from || todayInLisbon();
  const to = sp.to && sp.to >= from ? sp.to : from;
  const collabFilter = sp.collab || "";

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!me) redirect("/login");
  if (!["admin", "gestor"].includes(me.role)) redirect("/app");

  const companyId = me.company_id;
  const toExclusive = addDaysToDateString(to, 1);

  // ── Colaboradores ──────────────────────────────────────────────────────────
  let collabQuery = admin
    .from("profiles")
    .select("id, full_name, contracted_hours_month")
    .eq("company_id", companyId)
    .eq("role", "colaborador")
    .eq("status", "ativo")
    .order("full_name");
  if (collabFilter) collabQuery = collabQuery.eq("id", collabFilter);
  const { data: collaborators } = await collabQuery;
  const collabs = collaborators ?? [];
  const collabIds = collabs.map((c) => c.id);

  // ── Dados do período (timesheets, ausências, equipas, serviços) ─────────────
  const [tsRes, absRes, tmRes, svcRes, allCollabsRes] = await Promise.all([
    admin
      .from("timesheets")
      .select("id, collaborator_id, clock_in_at, clock_out_at, duration_minutes, service_id")
      .eq("company_id", companyId)
      .gte("clock_in_at", toLisbonTimestamp(from, "00:00"))
      .lt("clock_in_at", toLisbonTimestamp(toExclusive, "00:00")),
    admin
      .from("absences")
      .select("collaborator_id, starts_on, ends_on")
      .eq("company_id", companyId)
      .lte("starts_on", to)
      .gte("ends_on", from),
    collabIds.length
      ? admin.from("team_members").select("collaborator_id, team_id").is("left_at", null).in("collaborator_id", collabIds)
      : Promise.resolve({ data: [] as { collaborator_id: string; team_id: string }[] }),
    admin
      .from("services")
      .select("id, team_id, scheduled_start, scheduled_end")
      .eq("company_id", companyId)
      .not("team_id", "is", null)
      .gte("scheduled_start", toLisbonTimestamp(from, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(toExclusive, "00:00")),
    // Para o seletor de colaborador (lista completa, independente do filtro)
    admin
      .from("profiles")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("role", "colaborador")
      .eq("status", "ativo")
      .order("full_name"),
  ]);

  const timesheets = tsRes.data ?? [];
  const absences = absRes.data ?? [];
  const memberships = (tmRes.data ?? []) as { collaborator_id: string; team_id: string }[];
  const services = (svcRes.data ?? []) as { id: string; team_id: string; scheduled_start: string; scheduled_end: string }[];

  // team_id -> [collaboratorId]
  const teamToCollabs = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = teamToCollabs.get(m.team_id) ?? [];
    arr.push(m.collaborator_id);
    teamToCollabs.set(m.team_id, arr);
  }

  // Prev. Serviços (minutos) e serviço candidato por (colaborador|dia)
  const prevMinByKey = new Map<string, number>();
  const candidateSvcByKey = new Map<string, string>();
  for (const s of services) {
    if (!s.team_id) continue;
    const day = s.scheduled_start.slice(0, 10);
    const durMin = Math.max(
      0,
      Math.round((new Date(s.scheduled_end).getTime() - new Date(s.scheduled_start).getTime()) / 60_000),
    );
    for (const cid of teamToCollabs.get(s.team_id) ?? []) {
      const key = `${cid}|${day}`;
      prevMinByKey.set(key, (prevMinByKey.get(key) ?? 0) + durMin);
      if (!candidateSvcByKey.has(key)) candidateSvcByKey.set(key, s.id);
    }
  }

  // timesheets por (colaborador|dia)
  const tsByKey = new Map<string, PontoRow["timesheets"]>();
  for (const t of timesheets) {
    const day = (t.clock_in_at ?? "").slice(0, 10);
    if (!day) continue;
    const key = `${t.collaborator_id}|${day}`;
    const arr = tsByKey.get(key) ?? [];
    arr.push({
      id: t.id,
      clock_in_at: t.clock_in_at,
      clock_out_at: t.clock_out_at,
      duration_minutes: t.duration_minutes,
    });
    tsByKey.set(key, arr);
  }

  const absByCollab = new Map<string, { starts_on: string; ends_on: string }[]>();
  for (const a of absences) {
    const arr = absByCollab.get(a.collaborator_id) ?? [];
    arr.push({ starts_on: a.starts_on, ends_on: a.ends_on });
    absByCollab.set(a.collaborator_id, arr);
  }

  // ── Montar linhas (colaborador × dia) ───────────────────────────────────────
  const days = dayRange(from, to);
  const rows: PontoRow[] = [];
  for (const c of collabs) {
    const contractedMin = dailyContractedMinutes(c.contracted_hours_month);
    for (const day of days) {
      const key = `${c.id}|${day}`;
      const ts = tsByKey.get(key) ?? [];
      const prevServicesMin = prevMinByKey.get(key) ?? 0;
      const absent = isAbsentOn(absByCollab.get(c.id) ?? [], day);
      // Saltar linhas totalmente vazias quando há um intervalo de vários dias
      if (days.length > 1 && ts.length === 0 && prevServicesMin === 0 && !absent) continue;
      rows.push({
        collaboratorId: c.id,
        collaboratorName: c.full_name,
        day,
        contractedMin,
        prevServicesMin,
        absent,
        timesheets: ts,
        candidateServiceId: candidateSvcByKey.get(key) ?? null,
      });
    }
  }

  return (
    <div>
      <Header title="Registo de Ponto" subtitle="Recursos Humanos" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <PontoTabs />
        <RegistoPontoClient
          rows={rows}
          collaborators={(allCollabsRes.data ?? []) as { id: string; full_name: string }[]}
          companyId={companyId}
          from={from}
          to={to}
          collabFilter={collabFilter}
        />
      </div>
    </div>
  );
}
