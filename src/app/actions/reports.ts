"use server";

import { createAdminClient } from "@/lib/supabase/admin";

export interface HorasRow {
  id: string;
  full_name: string;
  contracted_hours_month: number;
  actual_minutes: number;
  services_count: number;
}

export interface AbsentismoRow {
  id: string;
  full_name: string;
  total_dias: number;
  doenca_com_baixa: number;
  doenca_sem_baixa: number;
  pessoal_justificado: number;
  pessoal_injustificado: number;
  ferias: number;
  outros: number;
}

export interface ClientServiceItem {
  date: string;
  location_name: string;
  duration_min: number;
  value: number;
}

export interface ReceitaRow {
  client_id: string;
  client_name: string;
  servicos_count: number;
  total_receita: number;
  services: ClientServiceItem[];
}

export interface ServicosRow {
  team_id: string;
  team_name: string;
  concluido: number;
  cancelado: number;
  falta: number;
  agendado: number;
  total: number;
}

export interface ReportsData {
  horas: HorasRow[];
  absentismo: AbsentismoRow[];
  receita: ReceitaRow[];
  servicosPorEquipa: ServicosRow[];
  vatRate: number;
}

export async function getReportsData(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<ReportsData> {
  const admin = createAdminClient();

  // ─── 1. HORAS ─────────────────────────────────────────────
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, full_name, contracted_hours_month")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .in("role", ["colaborador", "gestor"])
    .order("full_name");

  const profileIds = (profiles ?? []).map((p) => p.id);

  const { data: timesheets } = profileIds.length > 0
    ? await admin
        .from("timesheets")
        .select("collaborator_id, duration_minutes, service_id")
        .eq("company_id", companyId)
        .in("collaborator_id", profileIds)
        .gte("clock_in_at", `${startDate}T00:00:00`)
        .lte("clock_in_at", `${endDate}T23:59:59`)
    : { data: [] as { collaborator_id: string; duration_minutes: number | null; service_id: string }[] };

  const horasMap = new Map<string, { minutes: number; serviceIds: Set<string> }>();
  for (const p of profiles ?? []) {
    horasMap.set(p.id, { minutes: 0, serviceIds: new Set() });
  }
  for (const t of timesheets ?? []) {
    const entry = horasMap.get(t.collaborator_id);
    if (entry) {
      entry.minutes += t.duration_minutes ?? 0;
      if (t.service_id) entry.serviceIds.add(t.service_id);
    }
  }

  const horas: HorasRow[] = (profiles ?? []).map((p) => {
    const entry = horasMap.get(p.id) ?? { minutes: 0, serviceIds: new Set() };
    return {
      id: p.id,
      full_name: p.full_name,
      contracted_hours_month: p.contracted_hours_month ?? 168,
      actual_minutes: entry.minutes,
      services_count: entry.serviceIds.size,
    };
  });

  // ─── 2. ABSENTISMO ────────────────────────────────────────
  const { data: absences } = await admin
    .from("absences")
    .select("collaborator_id, absence_type, starts_on, ends_on")
    .eq("company_id", companyId)
    .lte("starts_on", endDate)
    .gte("ends_on", startDate);

  const absMap = new Map<string, AbsentismoRow>();
  for (const p of profiles ?? []) {
    absMap.set(p.id, {
      id: p.id,
      full_name: p.full_name,
      total_dias: 0,
      doenca_com_baixa: 0,
      doenca_sem_baixa: 0,
      pessoal_justificado: 0,
      pessoal_injustificado: 0,
      ferias: 0,
      outros: 0,
    });
  }

  for (const a of absences ?? []) {
    const entry = absMap.get(a.collaborator_id);
    if (!entry) continue;
    const dias =
      Math.round(
        (new Date(a.ends_on).getTime() - new Date(a.starts_on).getTime()) /
          (1000 * 60 * 60 * 24),
      ) + 1;
    entry.total_dias += dias;
    switch (a.absence_type) {
      case "doenca_com_baixa":      entry.doenca_com_baixa += dias; break;
      case "doenca_sem_baixa":      entry.doenca_sem_baixa += dias; break;
      case "pessoal_justificado":   entry.pessoal_justificado += dias; break;
      case "pessoal_injustificado": entry.pessoal_injustificado += dias; break;
      case "ferias":                entry.ferias += dias; break;
      default:                      entry.outros += dias;
    }
  }

  const absentismo = Array.from(absMap.values()).filter((r) => r.total_dias > 0);

  // ─── 3. RECEITA ───────────────────────────────────────────
  const { data: services } = await admin
    .from("services")
    .select("id, location_id, calculated_value, manual_value, status, scheduled_start, actual_start, actual_end")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", `${startDate}T00:00:00`)
    .lte("scheduled_start", `${endDate}T23:59:59`);

  const locationIds = [
    ...new Set((services ?? []).map((s) => s.location_id).filter(Boolean)),
  ];

  const { data: locations } = locationIds.length > 0
    ? await admin
        .from("locations")
        .select("id, client_id, name")
        .in("id", locationIds)
    : { data: [] as { id: string; client_id: string; name: string }[] };

  const { data: clients } = await admin
    .from("clients")
    .select("id, name")
    .eq("company_id", companyId)
    .order("name");

  const locationMap = Object.fromEntries(
    (locations ?? []).map((l) => [l.id, { client_id: l.client_id, name: l.name }]),
  );
  const clientNameMap = Object.fromEntries(
    (clients ?? []).map((c) => [c.id, c.name]),
  );

  const receitaMap = new Map<string, ReceitaRow>();
  for (const s of services ?? []) {
    const loc = locationMap[s.location_id];
    if (!loc) continue;
    const { client_id: clientId, name: locName } = loc;
    const value = s.manual_value ?? s.calculated_value ?? 0;

    let durationMin = 0;
    if (s.actual_start && s.actual_end) {
      durationMin = Math.round(
        (new Date(s.actual_end).getTime() - new Date(s.actual_start).getTime()) / 60000,
      );
    }

    if (!receitaMap.has(clientId)) {
      receitaMap.set(clientId, {
        client_id: clientId,
        client_name: clientNameMap[clientId] ?? "—",
        servicos_count: 0,
        total_receita: 0,
        services: [],
      });
    }
    const entry = receitaMap.get(clientId)!;
    entry.servicos_count += 1;
    entry.total_receita += value;
    entry.services.push({ date: s.scheduled_start, location_name: locName, duration_min: durationMin, value });
  }

  const receita = Array.from(receitaMap.values()).sort((a, b) => b.total_receita - a.total_receita);

  // ─── 4. SERVIÇOS POR EQUIPA ───────────────────────────────
  const { data: allServices } = await admin
    .from("services")
    .select("team_id, status")
    .eq("company_id", companyId)
    .gte("scheduled_start", `${startDate}T00:00:00`)
    .lte("scheduled_start", `${endDate}T23:59:59`);

  const { data: teams } = await admin
    .from("teams")
    .select("id, name")
    .eq("company_id", companyId)
    .eq("active", true);

  const servicosMap = new Map<string, ServicosRow>();
  for (const t of teams ?? []) {
    servicosMap.set(t.id, { team_id: t.id, team_name: t.name, concluido: 0, cancelado: 0, falta: 0, agendado: 0, total: 0 });
  }

  for (const s of allServices ?? []) {
    const teamId = s.team_id ?? "_sem_equipa";
    if (!servicosMap.has(teamId)) {
      servicosMap.set(teamId, { team_id: teamId, team_name: "Sem equipa", concluido: 0, cancelado: 0, falta: 0, agendado: 0, total: 0 });
    }
    const entry = servicosMap.get(teamId)!;
    entry.total += 1;
    if (s.status === "concluido") entry.concluido += 1;
    else if (s.status === "cancelado") entry.cancelado += 1;
    else if (s.status === "falta") entry.falta += 1;
    else entry.agendado += 1;
  }

  const servicosPorEquipa = Array.from(servicosMap.values()).sort((a, b) => b.total - a.total);

  // Buscar IVA das configurações da empresa (sem import circular)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settingsRow } = await (admin as any)
    .from("company_settings")
    .select("vat_rate")
    .eq("company_id", companyId)
    .single();

  const vatRate: number = (settingsRow?.vat_rate as number | null | undefined) ?? 23;

  return { horas, absentismo, receita, servicosPorEquipa, vatRate };
}
