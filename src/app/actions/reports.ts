"use server";

import { requireProfile } from "@/lib/auth-guard";
import { addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";

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

export interface FaturacaoDiaRow {
  date: string;
  servicos_count: number;
  subtotal: number;
  iva: number;
  total: number;
}

export interface ReportsData {
  horas: HorasRow[];
  absentismo: AbsentismoRow[];
  receita: ReceitaRow[];
  servicosPorEquipa: ServicosRow[];
  faturacaoDiaria: FaturacaoDiaRow[];
  vatRate: number;
}

export async function getReportsData(
  _companyId: string,
  startDate: string,
  endDate: string,
): Promise<ReportsData> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) throw new Error(guard.error);
  const { admin, profile } = guard;
  // company_id vem SEMPRE da sessão — nunca confiar no parâmetro do cliente.
  const companyId = profile.company_id;
  // Limites do intervalo ancorados ao fuso de Lisboa (nunca strings "naive",
  // que o Postgres interpreta como UTC e desloca a janela em hora de verão).
  const startTs = toLisbonTimestamp(startDate, "00:00");
  const endExclusiveTs = toLisbonTimestamp(addDaysToDateString(endDate, 1), "00:00");

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
        .gte("clock_in_at", startTs)
        .lt("clock_in_at", endExclusiveTs)
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

  // Taxa de IVA das configurações da empresa (usada na Receita e na Faturação diária)
  const { data: settingsRow } = await admin
    .from("company_settings")
    .select("vat_rate")
    .eq("company_id", companyId)
    .single();

  const vatRate: number = settingsRow?.vat_rate ?? 23;
  const vatFactor = vatRate / 100;

  // ─── 3. RECEITA ───────────────────────────────────────────
  const { data: services } = await admin
    .from("services")
    .select("id, location_id, contract_id, calculated_value, manual_value, apply_vat, status, scheduled_start, actual_start, actual_end")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", startTs)
    .lt("scheduled_start", endExclusiveTs);

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
    .gte("scheduled_start", startTs)
    .lt("scheduled_start", endExclusiveTs);

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

  // ─── 5. FATURAÇÃO DIÁRIA ───────────────────────────────────
  // Reaproveita os serviços concluídos já carregados para a Receita, mas trata
  // as avenças (contracts.fixed_monthly) à parte: o serviço em si fica gravado
  // com calculated_value=0 (só agenda; fatura-se 1x/mês), por isso o valor
  // mensal da avença é dividido pelos serviços realmente prestados NESTE mês
  // (o intervalo startDate–endDate do ecrã de Relatórios é sempre um mês
  // completo). Ex.: avença de 300€ com 3 serviços no mês → 100€ em cada dia
  // em que houve serviço.
  const contractIds = [...new Set((services ?? []).map((s) => s.contract_id).filter(Boolean))] as string[];
  const { data: contractsData } = contractIds.length > 0
    ? await admin
        .from("contracts")
        .select("id, fixed_monthly, fixed_price, apply_vat")
        .in("id", contractIds)
    : { data: [] as { id: string; fixed_monthly: boolean; fixed_price: number | null; apply_vat: boolean }[] };
  const contractMap = Object.fromEntries((contractsData ?? []).map((c) => [c.id, c]));

  const avencaCountByContract = new Map<string, number>();
  for (const s of services ?? []) {
    if (!s.contract_id) continue;
    if (!contractMap[s.contract_id]?.fixed_monthly) continue;
    avencaCountByContract.set(s.contract_id, (avencaCountByContract.get(s.contract_id) ?? 0) + 1);
  }

  const diaMap = new Map<string, { servicos_count: number; subtotal: number; iva: number }>();
  for (const s of services ?? []) {
    const day = (s.scheduled_start as string).slice(0, 10);
    if (!diaMap.has(day)) diaMap.set(day, { servicos_count: 0, subtotal: 0, iva: 0 });
    const entry = diaMap.get(day)!;
    entry.servicos_count += 1;

    const contract = s.contract_id ? contractMap[s.contract_id] : null;
    let value: number;
    let hasVat: boolean;
    if (contract?.fixed_monthly) {
      const count = avencaCountByContract.get(s.contract_id!) ?? 1;
      value = (contract.fixed_price ?? 0) / count;
      hasVat = contract.apply_vat === true;
    } else {
      value = s.manual_value ?? s.calculated_value ?? 0;
      hasVat = s.apply_vat !== false;
    }
    entry.subtotal += value;
    entry.iva += hasVat ? value * vatFactor : 0;
  }

  const faturacaoDiaria: FaturacaoDiaRow[] = Array.from(diaMap.entries())
    .map(([date, v]) => ({
      date,
      servicos_count: v.servicos_count,
      subtotal: Math.round(v.subtotal * 100) / 100,
      iva: Math.round(v.iva * 100) / 100,
      total: Math.round((v.subtotal + v.iva) * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { horas, absentismo, receita, servicosPorEquipa, faturacaoDiaria, vatRate };
}
