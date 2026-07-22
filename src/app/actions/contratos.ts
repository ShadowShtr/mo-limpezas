"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { maxReferenceNumber } from "@/lib/services/reference";
import { auditLog } from "@/lib/audit";
import { hasOverlappingMonthlyContract } from "@/lib/contract-overlap";
import { isValidIsoDateString, isValidFiniteNumber } from "@/lib/utils";
import { getOccurrences, DOW_TO_KEY } from "@/lib/contract-occurrences";
import { assertCriticalFieldsLoaded, CRITICAL_FIELDS_BLOCKED_MESSAGE } from "@/lib/critical-fields";
import { calculateServiceValue } from "@/lib/service-value";
import { revalidateBusinessPaths } from "@/lib/revalidate-business";
import type { ScheduleDay } from "@/types/database";

export interface ContratoInput {
  location_id: string;
  name?: string;
  hourly_rate?: number | null;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on?: string;
  status: string;
  notes?: string;
  cleaning_type?: string | null;
  payment_status?: string | null;
  upholstery_type?: string | null;
  upholstery_notes?: string | null;
  upholstery_units?: number | null;
  upholstery_unit_price?: number | null;
  // Estofos por unidade: valor fixo por ocorrência (qtd × preço); ignora cálculo por hora.
  unit_value?: number | null;
  // Valor fixo: no modo mensal é o valor da avença/mês. Tem prioridade.
  fixed_price?: number | null;
  // Mecânica de faturação: true = valor fixo mensal (avença); false = por hora/serviço.
  fixed_monthly?: boolean;
  // IVA do contrato (propaga-se aos serviços gerados).
  apply_vat?: boolean;
  // Override do nº de pessoas que multiplica o valor/hora. null = usar o tamanho da equipa.
  num_people?: number | null;
  company_id: string;
  created_by: string;
}

// Valida os campos numéricos financeiros/quantidade de um contrato antes de
// gravar — evita que um valor NaN/negativo/absurdo (chamada direta ao action,
// fora do formulário) corrompa o cálculo de faturação/serviços gerados.
function validateContratoNumbers(input: Pick<ContratoInput,
  "hourly_rate" | "interval_days" | "upholstery_units" | "upholstery_unit_price" |
  "unit_value" | "fixed_price" | "num_people"
>): string | null {
  if (!isValidFiniteNumber(input.hourly_rate)) return "Valor/hora inválido.";
  if (!Number.isFinite(input.interval_days) || input.interval_days < 1 || input.interval_days > 365) {
    return "Intervalo de dias inválido.";
  }
  if (!isValidFiniteNumber(input.upholstery_units)) return "Unidades de estofo inválidas.";
  if (!isValidFiniteNumber(input.upholstery_unit_price)) return "Preço por unidade de estofo inválido.";
  if (!isValidFiniteNumber(input.unit_value)) return "Valor por unidade inválido.";
  if (!isValidFiniteNumber(input.fixed_price)) return "Valor fixo inválido.";
  if (input.num_people != null && (!Number.isFinite(input.num_people) || input.num_people < 1 || input.num_people > 50)) {
    return "Número de pessoas inválido.";
  }
  return null;
}

/**
 * Conta os membros ativos (left_at IS NULL) de cada equipa indicada.
 * Devolve um Map team_id → nº de pessoas (mínimo 1 quando há equipa sem membros).
 */
async function getTeamSizes(
  admin: ReturnType<typeof createAdminClient>,
  teamIds: string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const unique = [...new Set(teamIds.filter(Boolean))];
  if (unique.length === 0) return sizes;

  const { data } = await admin
    .from("team_members")
    .select("team_id")
    .in("team_id", unique)
    .is("left_at", null);

  for (const id of unique) sizes.set(id, 0);
  for (const row of data ?? []) {
    sizes.set(row.team_id, (sizes.get(row.team_id) ?? 0) + 1);
  }
  return sizes;
}

/**
 * Nº de pessoas de uma ocorrência (mínimo 1):
 * - com equipa → tamanho da equipa (membros ativos);
 * - sem equipa → o num_people do dia (preenchido à mão).
 */
function resolvePeople(schedule: ScheduleDay, teamSizes: Map<string, number>): number {
  if (schedule.team_id) {
    const size = teamSizes.get(schedule.team_id) ?? 0;
    return size > 0 ? size : 1;
  }
  return schedule.num_people != null && schedule.num_people >= 1
    ? Math.floor(schedule.num_people)
    : 1;
}

function addMins(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.min(Math.floor(total / 60), 23)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Data YYYY-MM-DD a partir dos componentes LOCAIS do Date (não toISOString, que
 * converte para UTC e desloca ±1 dia se o runtime não estiver em UTC). As datas
 * das ocorrências são construídas em hora local, por isso lê-se em hora local.
 */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Timezone Europe/Lisbon ──────────────────────────────────────────────────
// Mesma lógica do cron generate-services: grava timestamps com o offset de
// Lisboa (não "naivos", que o PostgreSQL interpretaria como UTC e deslocaria
// a hora ±1h, podendo fazer a ocorrência cair fora do dia no calendário).

const LISBON_TZ = "Europe/Lisbon";

function toLisbonTimestamp(dateStr: string, timeStr: string): string {
  const midday = new Date(`${dateStr}T12:00:00Z`);
  const tzParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LISBON_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(midday);
  const tzName = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  let offset = "+00:00";
  const m = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (m) {
    const sign = m[1];
    const h = m[2].padStart(2, "0");
    const min = (m[3] ?? "00").padStart(2, "0");
    offset = `${sign}${h}:${min}`;
  }
  return `${dateStr}T${timeStr}:00${offset}`;
}

async function generateServicesForContract(
  admin: ReturnType<typeof createAdminClient>,
  contractId: string,
  companyId: string,
  locationId: string,
  hourlyRate: number | null,
  contract: Parameters<typeof getOccurrences>[0],
  extras: {
    cleaning_type?: string | null;
    payment_status?: string | null;
    upholstery_type?: string | null;
    upholstery_notes?: string | null;
    upholstery_units?: number | null;
    upholstery_unit_price?: number | null;
    unit_value?: number | null;
    fixed_price?: number | null;
    fixed_monthly?: boolean;
    apply_vat?: boolean;
    num_people?: number | null;
  } = {},
) {
  const monthly = extras.fixed_monthly === true;
  const applyVat = extras.apply_vat ?? false;
  const fixedPrice = extras.fixed_price != null && extras.fixed_price > 0
    ? parseFloat(extras.fixed_price.toFixed(2)) : null;
  // Tamanhos das equipas usadas no padrão (para o cálculo por pessoa).
  const teamSizes = await getTeamSizes(
    admin,
    (contract.schedule_days ?? []).map((s) => s.team_id ?? "").filter(Boolean),
  );
  const now = new Date();
  // Gera 3 meses de ocorrências, ancorados no INÍCIO do contrato:
  // - contrato que já começou (ou começa este mês) → mês atual + 2;
  // - contrato marcado para o futuro (depois dos 3 meses) → 3 meses a contar
  //   do mês de início, para que apareça à mesma no calendário.
  const contractStart = new Date(contract.starts_on + "T00:00:00");
  const anchor = contractStart > now
    ? new Date(contractStart.getFullYear(), contractStart.getMonth(), 1)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const rangeStart = anchor;
  const rangeEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 3, 0, 23, 59, 59);

  // Contador de referência baseado no MÁXIMO existente (não count(*), que colide
  // com buracos deixados por serviços apagados/cancelados → erro de unicidade).
  let counter = await maxReferenceNumber(admin, companyId);

  const occurrences = getOccurrences(contract, rangeStart, rangeEnd);

  for (const { date, schedule } of occurrences) {
    const dateStr = toLocalDateStr(date);
    const nextDateStr = toLocalDateStr(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));

    const { data: dup } = await admin
      .from("services")
      .select("id")
      .eq("contract_id", contractId)
      .gte("scheduled_start", toLisbonTimestamp(dateStr, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(nextDateStr, "00:00"))
      .maybeSingle();
    if (dup) continue;

    const endTime = addMins(schedule.start_time, schedule.duration_min);
    // Nº de pessoas desta ocorrência: cada colaboradora conta como uma hora.
    const people = resolvePeople(schedule, teamSizes);
    // Prioridade do valor: mensal (avença) → 0 (só agenda; fatura 1x/mês) >
    // valor fixo por-serviço > estofos por unidade > hora.
    const calculatedValue =
      monthly
        ? 0
        : fixedPrice != null
        ? fixedPrice
        : extras.unit_value != null && extras.unit_value > 0
        ? parseFloat(extras.unit_value.toFixed(2))
        : hourlyRate != null
        ? parseFloat(((schedule.duration_min / 60) * hourlyRate * people).toFixed(2))
        : null;
    // Faturação fixa (mensal ou por-serviço) não usa valor/hora no serviço.
    const rowHourlyRate = monthly || fixedPrice != null ? null : hourlyRate;

    // Insere com retry: reference_number tem constraint única (migration 031) e
    // o contador baseado em count pode colidir com refs já existentes (gaps).
    // Sem retry, a inserção falhava em silêncio e a ocorrência (ex.: o dia de
    // início) desaparecia do calendário.
    const baseRow = {
      company_id: companyId,
      location_id: locationId,
      team_id: schedule.team_id || null,
      contract_id: contractId,
      scheduled_start: toLisbonTimestamp(dateStr, schedule.start_time),
      scheduled_end: toLisbonTimestamp(dateStr, endTime),
      hourly_rate: rowHourlyRate,
      calculated_value: calculatedValue,
      apply_vat: applyVat,
      num_people: people,
      status: "agendado",
      cleaning_type: extras.cleaning_type ?? null,
      payment_status: extras.payment_status ?? null,
      upholstery_type: extras.upholstery_type ?? null,
      upholstery_notes: extras.upholstery_notes ?? null,
      upholstery_units: extras.upholstery_units ?? null,
      upholstery_unit_price: extras.upholstery_unit_price ?? null,
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      counter++;
      const { error: insErr } = await admin
        .from("services")
        .insert({ ...baseRow, reference_number: String(counter).padStart(4, "0") });
      if (!insErr) break;
      if (insErr.code !== "23505") break; // erro diferente de duplicado → desiste desta ocorrência
    }
  }
}

/**
 * Reescreve os serviços FUTUROS ainda `agendado` deste contrato segundo o padrão
 * atual: equipa, hora de início/fim e valor (por dia da semana). Garante que ao
 * mudar a equipa/horário no contrato a alteração se replica em TODAS as ocorrências
 * futuras, não só nas que ainda não tinham sido geradas. Não toca em exceções
 * movidas à mão (is_exception) nem em ocorrências passadas/em curso/concluídas.
 */
async function updateFutureServiceValuesForContract(
  admin: ReturnType<typeof createAdminClient>,
  contractId: string,
  companyId: string,
  hourlyRate: number | null,
  scheduleDays: ScheduleDay[],
  fixedPrice: number | null = null,
  fixedMonthly = false,
  applyVat = false,
) {
  const fixed = fixedPrice != null && fixedPrice > 0 ? parseFloat(fixedPrice.toFixed(2)) : null;
  const { data: services } = await admin
    .from("services")
    .select("id, scheduled_start, team_id, is_exception")
    .eq("company_id", companyId)
    .eq("contract_id", contractId)
    .eq("status", "agendado")
    .gte("scheduled_start", new Date().toISOString());

  const defaultSchedule = scheduleDays?.[0];
  if (!defaultSchedule) return;

  // Tamanhos das equipas do padrão (para o cálculo por pessoa).
  const teamSizes = await getTeamSizes(
    admin,
    (scheduleDays ?? []).map((s) => s.team_id ?? "").filter(Boolean),
  );

  for (const service of services ?? []) {
    if (service.is_exception) continue;

    const dateStr = (service.scheduled_start as string).slice(0, 10);
    // Dia da semana estável a partir da data (meio-dia UTC evita desvios de fuso).
    const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    const dayKey = DOW_TO_KEY[dow];
    const schedule = scheduleDays.find((s) => s.day === dayKey) ?? defaultSchedule;

    const endTime = addMins(schedule.start_time, schedule.duration_min);
    const people = resolvePeople(schedule, teamSizes);
    const calculatedValue = calculateServiceValue({
      durationMin: schedule.duration_min,
      hourlyRate,
      numPeople: people,
      manualValue: null,
      fixedMonthly,
      contractFixedPrice: fixed,
      upholsteryUnits: null,
      upholsteryUnitPrice: null,
    });

    const syncUpdate = {
      team_id: schedule.team_id || null,
      scheduled_start: toLisbonTimestamp(dateStr, schedule.start_time),
      scheduled_end: toLisbonTimestamp(dateStr, endTime),
      hourly_rate: fixedMonthly || fixed != null ? null : hourlyRate,
      calculated_value: calculatedValue,
      apply_vat: applyVat,
      num_people: people,
    };

    // contract_synced_at declara ao trigger trg_services_mark_exception (migração
    // 059) que este update é a sincronização legítima do contrato — sem ele, o
    // trigger marcaria a ocorrência como exceção manual e as próximas sincronizações
    // deixariam de a atualizar. Fallback sem a coluna enquanto a 059 não estiver
    // aplicada (PGRST204/42703 = coluna desconhecida).
    const { error: syncErr } = await admin
      .from("services")
      .update({ ...syncUpdate, contract_synced_at: new Date().toISOString() })
      .eq("id", service.id)
      .eq("company_id", companyId);
    if (syncErr && (syncErr.code === "PGRST204" || syncErr.code === "42703")) {
      await admin
        .from("services")
        .update(syncUpdate)
        .eq("id", service.id)
        .eq("company_id", companyId);
    }
  }
}

/**
 * Apaga serviços FUTUROS ainda `agendado` deste contrato que já não correspondem
 * ao padrão atual (início mudou para mais tarde, fim antecipado, dia da semana
 * alterado, frequência alterada). Nunca toca em ocorrências passadas, em curso,
 * concluídas, faltas, canceladas, nem em exceções movidas à mão (is_exception).
 */
async function reconcileFutureServicesForContract(
  admin: ReturnType<typeof createAdminClient>,
  contractId: string,
  companyId: string,
  contract: Parameters<typeof getOccurrences>[0],
) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Janela ampla (6 meses) para cobrir o que o cron mensal possa ter gerado.
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 6, 0, 23, 59, 59);

  // Conjunto de datas válidas (YYYY-MM-DD) segundo o padrão atual.
  const validDates = new Set(
    getOccurrences(contract, todayStart, windowEnd).map(
      ({ date }) => date.toISOString().split("T")[0],
    ),
  );

  const { data: future } = await admin
    .from("services")
    .select("id, scheduled_start, is_exception")
    .eq("company_id", companyId)
    .eq("contract_id", contractId)
    .eq("status", "agendado")
    .gte("scheduled_start", todayStart.toISOString());

  const toDelete = (future ?? [])
    .filter((s) => !s.is_exception)
    .filter((s) => !validDates.has((s.scheduled_start as string).slice(0, 10)))
    .map((s) => s.id);

  if (toDelete.length > 0) {
    await admin
      .from("services")
      .delete()
      .eq("company_id", companyId)
      .eq("contract_id", contractId)
      .in("id", toDelete);
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function createContrato(input: ContratoInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== input.company_id) {
    return { ok: false as const, error: "Sem permissao." };
  }

  if (!isValidIsoDateString(input.starts_on)) {
    return { ok: false as const, error: "Data de início inválida." };
  }
  if (input.ends_on && !isValidIsoDateString(input.ends_on)) {
    return { ok: false as const, error: "Data de fim inválida." };
  }
  const numbersError = validateContratoNumbers(input);
  if (numbersError) return { ok: false as const, error: numbersError };

  const { data: location } = await admin
    .from("locations")
    .select("id, client_id")
    .eq("id", input.location_id)
    .eq("company_id", profile.company_id)
    .single();
  if (!location) return { ok: false as const, error: "Local invalido." };

  if (input.fixed_monthly && input.status === "ativo") {
    const { overlapping } = await hasOverlappingMonthlyContract(admin, {
      companyId: profile.company_id,
      locationId: input.location_id,
      startsOn: input.starts_on,
      endsOn: input.ends_on || null,
    });
    if (overlapping) {
      return {
        ok: false as const,
        error: "Já existe uma avença mensal ativa para este local neste período. Encerre ou cancele o contrato anterior antes de criar outro.",
      };
    }
  }

  // Só toca no valor/hora do local quando o contrato é faturado por hora E o
  // formulário enviou o campo. Avença/valor fixo/estofos nunca apagam o valor
  // do local (foi assim que locais ficaram a calcular 0€ — ver auditoria de
  // reversões, Causa 7: contratos não-por-hora nem sempre enviam hourly_rate,
  // e "?? null" convertia essa ausência em apagar o valor real do local).
  const isHourlyCreate = !input.fixed_monthly && !(input.fixed_price != null && input.fixed_price > 0);
  if (isHourlyCreate && input.hourly_rate !== undefined && input.hourly_rate !== null) {
    await admin
      .from("locations")
      .update({ hourly_rate: input.hourly_rate })
      .eq("id", input.location_id)
      .eq("company_id", profile.company_id);
  }

  const { data: contract, error } = await admin
    .from("contracts")
    .insert({
      location_id: input.location_id,
      name: input.name || null,
      frequency: input.frequency,
      interval_days: input.interval_days,
      weekdays: input.weekdays,
      schedule_days: input.schedule_days,
      starts_on: input.starts_on,
      ends_on: input.ends_on || null,
      status: input.status,
      notes: input.notes || null,
      cleaning_type: input.cleaning_type ?? null,
      payment_status: input.payment_status ?? null,
      upholstery_type: input.upholstery_type ?? null,
      upholstery_notes: input.upholstery_notes ?? null,
      upholstery_units: input.upholstery_units ?? null,
      upholstery_unit_price: input.upholstery_unit_price ?? null,
      fixed_price: input.fixed_price ?? null,
      fixed_monthly: input.fixed_monthly ?? false,
      apply_vat: input.apply_vat ?? false,
      num_people: input.num_people ?? null,
      company_id: profile.company_id,
      created_by: user.id,
    })
    .select("id, location_id, locations(hourly_rate)")
    .single();

  if (error) return { ok: false as const, error: error.message };

  // Gerar serviços imediatamente para os próximos 3 meses
  if (input.status === "ativo") {
    const hourlyRate = input.hourly_rate ?? null;

    await generateServicesForContract(
      admin,
      contract.id,
      profile.company_id,
      input.location_id,
      hourlyRate,
      {
        frequency: input.frequency,
        weekdays: input.weekdays,
        interval_days: input.interval_days,
        schedule_days: input.schedule_days,
        starts_on: input.starts_on,
        ends_on: input.ends_on || null,
        excluded_dates: [],
      },
      {
        cleaning_type: input.cleaning_type ?? null,
        payment_status: input.payment_status ?? null,
        upholstery_type: input.upholstery_type ?? null,
        upholstery_notes: input.upholstery_notes ?? null,
        upholstery_units: input.upholstery_units ?? null,
        upholstery_unit_price: input.upholstery_unit_price ?? null,
        unit_value: input.unit_value ?? null,
        fixed_price: input.fixed_price ?? null,
        fixed_monthly: input.fixed_monthly ?? false,
        apply_vat: input.apply_vat ?? false,
        num_people: input.num_people ?? null,
      },
    );
  }

  revalidateBusinessPaths({
    clientId: location.client_id,
    scopes: ["contratos", "calendario", "clientes", "cobrancas"],
  });
  return { ok: true as const };
}

export async function updateContrato(id: string, input: Omit<ContratoInput, "company_id" | "created_by">) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const criticalCheck = assertCriticalFieldsLoaded("contracts", input);
  if (!criticalCheck.ok) {
    return { ok: false as const, error: CRITICAL_FIELDS_BLOCKED_MESSAGE };
  }

  if (!isValidIsoDateString(input.starts_on)) {
    return { ok: false as const, error: "Data de início inválida." };
  }
  if (input.ends_on && !isValidIsoDateString(input.ends_on)) {
    return { ok: false as const, error: "Data de fim inválida." };
  }
  const numbersError = validateContratoNumbers(input);
  if (numbersError) return { ok: false as const, error: numbersError };

  const { data: location } = await admin
    .from("locations")
    .select("id, client_id")
    .eq("id", input.location_id)
    .eq("company_id", profile.company_id)
    .single();
  if (!location) return { ok: false as const, error: "Local invalido." };

  if (input.fixed_monthly && input.status === "ativo") {
    const { overlapping } = await hasOverlappingMonthlyContract(admin, {
      companyId: profile.company_id,
      locationId: input.location_id,
      startsOn: input.starts_on,
      endsOn: input.ends_on || null,
      excludeContractId: id,
    });
    if (overlapping) {
      return {
        ok: false as const,
        error: "Já existe uma avença mensal ativa para este local neste período. Encerre ou cancele o contrato anterior antes de criar outro.",
      };
    }
  }

  // Só toca no valor/hora do local quando o contrato é faturado por hora E o
  // formulário enviou o campo — ver o mesmo guard em createContrato (Causa 7).
  const isHourlyUpdate = !input.fixed_monthly && !(input.fixed_price != null && input.fixed_price > 0);
  if (isHourlyUpdate && input.hourly_rate !== undefined && input.hourly_rate !== null) {
    await admin
      .from("locations")
      .update({ hourly_rate: input.hourly_rate })
      .eq("id", input.location_id)
      .eq("company_id", profile.company_id);
  }

  // Valor antigo, só para a auditoria (ver comentário abaixo) — nunca bloqueia
  // o update se falhar.
  const { data: before } = await admin
    .from("contracts")
    .select("fixed_price, fixed_monthly, apply_vat")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();

  const { data: saved, error } = await admin.from("contracts").update({
    location_id: input.location_id,
    name: input.name || null,
    frequency: input.frequency,
    interval_days: input.interval_days,
    weekdays: input.weekdays,
    schedule_days: input.schedule_days,
    starts_on: input.starts_on,
    ends_on: input.ends_on || null,
    status: input.status,
    notes: input.notes || null,
    cleaning_type: input.cleaning_type ?? null,
    payment_status: input.payment_status ?? null,
    upholstery_type: input.upholstery_type ?? null,
    upholstery_notes: input.upholstery_notes ?? null,
    upholstery_units: input.upholstery_units ?? null,
    upholstery_unit_price: input.upholstery_unit_price ?? null,
    fixed_price: input.fixed_price ?? null,
    fixed_monthly: input.fixed_monthly ?? false,
    apply_vat: input.apply_vat ?? false,
    num_people: input.num_people ?? null,
  }).eq("id", id).eq("company_id", profile.company_id)
    .select("id, fixed_price, fixed_monthly, apply_vat")
    .single();

  if (error) return { ok: false as const, error: error.message };
  if (!saved) {
    return { ok: false as const, error: "Nada foi gravado (contrato não encontrado ou sem permissão). Atualize a página e tente novamente." };
  }

  // Read-after-write dos campos financeiros: o update devolve a linha gravada;
  // se o que persistiu não for o que foi enviado (trigger/constraint a intervir,
  // corrida com outra sessão), o utilizador fica a saber em vez de ver "sucesso"
  // com um valor diferente na base.
  const intendedFin = {
    fixed_price: input.fixed_price ?? null,
    fixed_monthly: input.fixed_monthly ?? false,
    apply_vat: input.apply_vat ?? false,
  };
  const finMismatch =
    Number(saved.fixed_price ?? -1) !== Number(intendedFin.fixed_price ?? -1) ||
    saved.fixed_monthly !== intendedFin.fixed_monthly ||
    saved.apply_vat !== intendedFin.apply_vat;
  if (finMismatch) {
    return {
      ok: false as const,
      error: "A alteração não foi confirmada na base de dados (os valores financeiros gravados divergem dos enviados). Nada foi considerado gravado — atualize a página e tente novamente.",
    };
  }

  // Auditoria do valor financeiro do contrato (avença/IVA) — só quando algo
  // muda de facto. Sem isto não há como recuperar um valor apagado por engano
  // (foi o que aconteceu quando a ficha do cliente carregava o contrato sem
  // estas colunas — ver src/lib/contrato-sheet-fields.ts).
  const after = { fixed_price: input.fixed_price ?? null, fixed_monthly: input.fixed_monthly ?? false, apply_vat: input.apply_vat ?? false };
  if (
    before &&
    (before.fixed_price !== after.fixed_price ||
      before.fixed_monthly !== after.fixed_monthly ||
      before.apply_vat !== after.apply_vat)
  ) {
    await auditLog({
      companyId: profile.company_id,
      actorId: user.id,
      action: "contrato_valor_alterado",
      entityType: "contract",
      entityId: id,
      before,
      after,
      source: "dashboard",
    }, admin);
  }

  // Datas excluídas manualmente (apagadas do calendário): preservam-se e continuam
  // a ser saltadas na regeneração, para o dia apagado nunca voltar.
  const { data: existing } = await admin
    .from("contracts").select("excluded_dates").eq("id", id).eq("company_id", profile.company_id).single();
  const excludedDates = (existing?.excluded_dates as string[] | null) ?? [];

  // Remove ocorrências futuras que deixaram de encaixar no padrão (ex.: data de
  // início mudou para mais tarde → apaga as visitas anteriores já geradas).
  await reconcileFutureServicesForContract(
    admin,
    id,
    profile.company_id,
    {
      frequency: input.frequency,
      weekdays: input.weekdays,
      interval_days: input.interval_days,
      schedule_days: input.schedule_days,
      starts_on: input.starts_on,
      ends_on: input.ends_on || null,
      excluded_dates: excludedDates,
    },
  );

  await updateFutureServiceValuesForContract(
    admin,
    id,
    profile.company_id,
    input.hourly_rate ?? null,
    input.schedule_days,
    input.fixed_price ?? null,
    input.fixed_monthly ?? false,
    input.apply_vat ?? false,
  );

  // Preenche ocorrências em falta dentro da janela (6 meses). É aditivo:
  // a verificação de duplicados garante que nunca reescreve nem duplica
  // ocorrências já existentes (incl. concluídas/em curso).
  if (input.status === "ativo") {
    await generateServicesForContract(
      admin,
      id,
      profile.company_id,
      input.location_id,
      input.hourly_rate ?? null,
      {
        frequency: input.frequency,
        weekdays: input.weekdays,
        interval_days: input.interval_days,
        schedule_days: input.schedule_days,
        starts_on: input.starts_on,
        ends_on: input.ends_on || null,
        excluded_dates: excludedDates,
      },
      {
        cleaning_type: input.cleaning_type ?? null,
        payment_status: input.payment_status ?? null,
        upholstery_type: input.upholstery_type ?? null,
        upholstery_notes: input.upholstery_notes ?? null,
        upholstery_units: input.upholstery_units ?? null,
        upholstery_unit_price: input.upholstery_unit_price ?? null,
        unit_value: input.unit_value ?? null,
        fixed_price: input.fixed_price ?? null,
        fixed_monthly: input.fixed_monthly ?? false,
        apply_vat: input.apply_vat ?? false,
        num_people: input.num_people ?? null,
      },
    );
  }

  revalidateBusinessPaths({
    clientId: location.client_id,
    scopes: ["contratos", "calendario", "clientes", "cobrancas"],
  });
  return { ok: true as const };
}

export async function deleteContrato(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { data: contract } = await admin
    .from("contracts")
    .select("id, location_id, locations(client_id)")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();
  if (!contract) return { ok: false as const, error: "Intervencao invalida." };

  // Apaga os serviços futuros agendados gerados por este contrato. Os passados
  // (concluídos/em curso) ficam com contract_id a NULL (FK SET NULL) — preserva
  // o histórico e a faturação.
  await admin
    .from("services")
    .delete()
    .eq("contract_id", id)
    .eq("company_id", profile.company_id)
    .eq("status", "agendado")
    .gte("scheduled_start", new Date().toISOString());

  const { error } = await admin
    .from("contracts")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false as const, error: error.message };

  const clientId = (contract.locations as { client_id?: string | null } | null)?.client_id ?? null;
  revalidateBusinessPaths({
    clientId,
    scopes: ["contratos", "calendario", "clientes", "cobrancas"],
  });
  return { ok: true as const };
}
