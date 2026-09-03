"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { maxReferenceNumber } from "@/lib/services/reference";
import { hasOverlappingMonthlyContract } from "@/lib/contract-overlap";
import { isValidIsoDateString, isValidFiniteNumber } from "@/lib/utils";
import { getOccurrences } from "@/lib/contract-occurrences";
import { assertCriticalFieldsLoaded, CRITICAL_FIELDS_BLOCKED_MESSAGE } from "@/lib/critical-fields";
import { revalidateBusinessPaths } from "@/lib/revalidate-business";
import type { ScheduleDay } from "@/types/database";
import { projectOccurrence, type ContractProjectionFields, type ServiceProjection } from "@/domain/scheduling/occurrence-projection";
import { reconcileContract } from "@/domain/scheduling/reconciliation";
import { toAtomicServicePlan, type AtomicServicePlanItem } from "@/domain/scheduling/atomic-contract-plan";
import type { ServiceRecord } from "@/domain/scheduling/occurrence-identity";

export interface ContratoInput {
  location_id: string;
  name?: string;
  hourly_rate?: number | null;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on?: string | null;
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
 * Apaga TODOS os serviços futuros ainda `agendado` deste contrato, sem exceção
 * (incl. ocorrências movidas à mão). Usado quando o contrato deixa de estar
 * ativo (pausado/cancelado/excluído) — nesse ponto a série inteira pára, não
 * faz sentido preservar uma exceção pontual de uma recorrência que já não existe.
 * Nunca toca em ocorrências passadas, em curso, concluídas, faltas ou canceladas.
 * Devolve quantos serviços foram removidos (para auditoria/mensagem ao utilizador).
 */
export async function removeFutureScheduledServices(
  admin: ReturnType<typeof createAdminClient>,
  contractId: string,
  companyId: string,
): Promise<number> {
  const { data: deleted, error } = await admin
    .from("services")
    .delete()
    .eq("company_id", companyId)
    .eq("contract_id", contractId)
    .eq("status", "agendado")
    .gte("scheduled_start", new Date().toISOString())
    .select("id");
  if (error) return 0;
  return deleted?.length ?? 0;
}

type AtomicContractSnapshot = {
  id: string;
  updated_at: string;
  excluded_dates: string[] | null;
  location_id: string;
  name: string | null;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  status: string;
  notes: string | null;
  cleaning_type: string | null;
  payment_status: string | null;
  upholstery_type: string | null;
  upholstery_notes: string | null;
  upholstery_units: number | null;
  upholstery_unit_price: number | null;
  fixed_price: number | null;
  fixed_monthly: boolean;
  apply_vat: boolean;
  num_people: number | null;
};

function asServiceStatus(value: string): ServiceRecord["status"] {
  if (["agendado", "em_curso", "concluido", "cancelado", "falta", "sem_cobertura"].includes(value)) {
    return value as ServiceRecord["status"];
  }
  return "agendado";
}

/**
 * Lê o estado futuro e constrói somente intenções. A aplicação dessas
 * intenções fica no RPC candidato, no mesmo commit do contrato.
 */
async function buildAtomicServicePlan(
  admin: ReturnType<typeof createAdminClient>,
  snapshot: AtomicContractSnapshot,
  companyId: string,
  hourlyRate: number | null,
): Promise<AtomicServicePlanItem[]> {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear(), today.getMonth() + 6, 0, 23, 59, 59);
  const contract: ContractProjectionFields = {
    id: snapshot.id,
    companyId,
    locationId: snapshot.location_id,
    fixedMonthly: snapshot.fixed_monthly,
    fixedPrice: snapshot.fixed_price,
    upholsteryType: snapshot.upholstery_type,
    upholsteryNotes: snapshot.upholstery_notes,
    upholsteryUnits: snapshot.upholstery_units,
    upholsteryUnitPrice: snapshot.upholstery_unit_price,
    cleaningType: snapshot.cleaning_type,
    paymentStatus: snapshot.payment_status,
    applyVat: snapshot.apply_vat,
    hourlyRate,
  };
  const teamIds = snapshot.schedule_days.map((day) => day.team_id ?? "").filter(Boolean);
  const teamSizes = await getTeamSizes(admin, teamIds);
  const expected = new Map<string, ServiceProjection>();

  if (snapshot.status === "ativo") {
    for (const { date, schedule } of getOccurrences({
      frequency: snapshot.frequency,
      weekdays: snapshot.weekdays,
      interval_days: snapshot.interval_days,
      schedule_days: snapshot.schedule_days,
      starts_on: snapshot.starts_on,
      ends_on: snapshot.ends_on,
      excluded_dates: snapshot.excluded_dates,
    }, todayStart, windowEnd)) {
      const civil = toLocalDateStr(date);
      expected.set(civil, projectOccurrence({
        contract,
        occurrenceDate: civil,
        schedule,
        teamSize: schedule.team_id ? teamSizes.get(schedule.team_id) ?? 1 : null,
      }));
    }
  }

  const { data: rows, error } = await admin
    .from("services")
    .select("id, contract_id, scheduled_start, status, is_exception, original_date, created_at, location_id, team_id, scheduled_end, hourly_rate, calculated_value, apply_vat, num_people, cleaning_type, payment_status, upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price")
    .eq("company_id", companyId)
    .eq("contract_id", snapshot.id)
    .eq("status", "agendado")
    .gte("scheduled_start", todayStart.toISOString());
  if (error) throw new Error(`Falha ao ler serviços futuros: ${error.message}`);

  const actual: ServiceRecord[] = (rows ?? []).map((row) => ({
    id: row.id,
    companyId,
    contractId: row.contract_id,
    occurrenceDate: row.scheduled_start.slice(0, 10),
    scheduledDate: row.scheduled_start.slice(0, 10),
    status: asServiceStatus(row.status),
    isException: row.is_exception,
    originalDate: row.original_date,
    createdAt: row.created_at,
  }));
  const actualProjections: Record<string, Partial<ServiceProjection>> = {};
  for (const row of rows ?? []) {
    actualProjections[row.id] = {
      companyId,
      contractId: snapshot.id,
      locationId: row.location_id,
      occurrenceDate: row.scheduled_start.slice(0, 10),
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      teamId: row.team_id,
      hourlyRate: row.hourly_rate,
      calculatedValue: row.calculated_value,
      applyVat: row.apply_vat,
      numPeople: row.num_people,
      cleaningType: row.cleaning_type,
      paymentStatus: row.payment_status,
      upholsteryType: row.upholstery_type,
      upholsteryNotes: row.upholstery_notes,
      upholsteryUnits: row.upholstery_units,
      upholsteryUnitPrice: row.upholstery_unit_price,
      status: "agendado",
    };
  }

  return toAtomicServicePlan(reconcileContract({
    contractStatus: snapshot.status as "ativo" | "pausado" | "cancelado",
    expected,
    actual,
    actualProjections,
    excludedDates: snapshot.excluded_dates,
  }), expected);
}

function atomicContractPatch(input: Omit<ContratoInput, "company_id" | "created_by">) {
  return {
    location_id: input.location_id,
    name: input.name ?? null,
    frequency: input.frequency,
    interval_days: input.interval_days,
    weekdays: input.weekdays,
    schedule_days: input.schedule_days,
    starts_on: input.starts_on,
    ends_on: input.ends_on ?? null,
    status: input.status,
    notes: input.notes ?? null,
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
  };
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

  const criticalCheck = assertCriticalFieldsLoaded("contracts", input as unknown as Record<string, unknown>, { requireAll: true });
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

  const { data: current, error: currentError } = await admin
    .from("contracts")
    .select("id, updated_at, excluded_dates, location_id, name, frequency, interval_days, weekdays, schedule_days, starts_on, ends_on, status, notes, cleaning_type, payment_status, upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price, fixed_price, fixed_monthly, apply_vat, num_people")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();
  if (currentError || !current) {
    return { ok: false as const, error: currentError?.message ?? "Intervenção não encontrada." };
  }

  const { data: currentLocation, error: currentLocationError } = await admin
    .from("locations")
    .select("hourly_rate")
    .eq("id", input.location_id)
    .eq("company_id", profile.company_id)
    .single();
  if (currentLocationError || !currentLocation) {
    return { ok: false as const, error: currentLocationError?.message ?? "Local invalido." };
  }

  const effectiveHourlyRate = input.hourly_rate !== undefined
    ? input.hourly_rate
    : currentLocation.hourly_rate;
  const nextSnapshot: AtomicContractSnapshot = {
    ...current,
    ...atomicContractPatch(input),
  };
  let plan: AtomicServicePlanItem[];
  try {
    plan = await buildAtomicServicePlan(admin, nextSnapshot, profile.company_id, effectiveHourlyRate);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Não foi possível preparar a alteração." };
  }

  const financialBefore = {
    fixed_price: current.fixed_price,
    fixed_monthly: current.fixed_monthly,
    apply_vat: current.apply_vat,
  };
  const financialAfter = {
    fixed_price: input.fixed_price ?? null,
    fixed_monthly: input.fixed_monthly ?? false,
    apply_vat: input.apply_vat ?? false,
  };
  const auditMeta = JSON.stringify(financialBefore) !== JSON.stringify(financialAfter)
    ? { action: "contrato_valor_alterado", before: financialBefore, after: financialAfter, source: "dashboard" }
    : null;

  // O RPC candidato é a única fronteira de escrita desta edição. Até a sua
  // migration ser numerada/aplicada, esta branch é deliberadamente não
  // mergeável (DB_FIRST_REQUIRED).
  const atomicRpc = admin.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  // A RPC candidata aplica contract_synced_at = now() para que a sincronização
  // legítima não transforme a ocorrência numa exceção manual.
  const { error: atomicError } = await atomicRpc("apply_contract_change_atomic", {
    p_company_id: profile.company_id,
    p_contract_id: id,
    p_expected_updated_at: current.updated_at,
    p_contract_patch: atomicContractPatch(input),
    p_update_location_hourly_rate: !input.fixed_monthly
      && !(input.fixed_price != null && input.fixed_price > 0)
      && input.hourly_rate !== undefined,
    p_location_hourly_rate: input.hourly_rate ?? null,
    p_plan: plan,
    p_actor_id: user.id,
    p_audit_meta: auditMeta,
  });
  if (atomicError) {
    const error = atomicError.code === "40001" || atomicError.message.includes("STALE_CONFLICT")
      ? "A intervenção foi alterada noutra sessão. Atualize a página e tente novamente."
      : atomicError.message;
    return { ok: false as const, error };
  }

  revalidateBusinessPaths({
    clientId: location.client_id,
    scopes: ["contratos", "calendario", "clientes", "cobrancas"],
  });
  return { ok: true as const };

  /* Legacy path intentionally disabled: its independent PostgREST writes are
     the bug fixed by the DB-first RPC candidate. */
  /*
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
    .select("id, fixed_price, fixed_monthly, apply_vat, cleaning_type, payment_status, upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price, num_people, status, schedule_days")
    .single();

  if (error) return { ok: false as const, error: error.message };
  if (!saved) {
    return { ok: false as const, error: "Nada foi gravado (contrato não encontrado ou sem permissão). Atualize a página e tente novamente." };
  }

  // Read-after-write COMPLETO: o update devolve a linha gravada; se qualquer
  // campo persistido divergir do enviado (trigger/constraint a intervir,
  // corrida com outra sessão), o utilizador fica a saber em vez de ver
  // "sucesso" com um valor diferente na base. (Auditoria F, Falha 5.)
  const num = (v: unknown) => (v == null ? null : Number(v));
  const intended: Record<string, unknown> = {
    fixed_price: num(input.fixed_price ?? null),
    fixed_monthly: input.fixed_monthly ?? false,
    apply_vat: input.apply_vat ?? false,
    cleaning_type: input.cleaning_type ?? null,
    payment_status: input.payment_status ?? null,
    upholstery_type: input.upholstery_type ?? null,
    upholstery_notes: input.upholstery_notes ?? null,
    upholstery_units: num(input.upholstery_units ?? null),
    upholstery_unit_price: num(input.upholstery_unit_price ?? null),
    num_people: num(input.num_people ?? null),
    status: input.status,
    schedule_days: JSON.stringify(input.schedule_days ?? null),
  };
  const persisted: Record<string, unknown> = {
    fixed_price: num(saved.fixed_price),
    fixed_monthly: saved.fixed_monthly,
    apply_vat: saved.apply_vat,
    cleaning_type: saved.cleaning_type ?? null,
    payment_status: saved.payment_status ?? null,
    upholstery_type: saved.upholstery_type ?? null,
    upholstery_notes: saved.upholstery_notes ?? null,
    upholstery_units: num(saved.upholstery_units),
    upholstery_unit_price: num(saved.upholstery_unit_price),
    num_people: num(saved.num_people),
    status: saved.status,
    schedule_days: JSON.stringify(saved.schedule_days ?? null),
  };
  const divergentes = Object.keys(intended).filter((k) => intended[k] !== persisted[k]);
  if (divergentes.length > 0) {
    return {
      ok: false as const,
      error: `A alteração não foi confirmada na base de dados (campos divergentes: ${divergentes.join(", ")}). Nada foi considerado gravado — atualize a página e tente novamente.`,
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
    input.status,
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
  */
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
  await removeFutureScheduledServices(admin, id, profile.company_id);

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
