"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import type { ScheduleDay } from "@/types/database";

export interface ContratoInput {
  location_id: string;
  name?: string;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on?: string;
  status: string;
  notes?: string;
  company_id: string;
  created_by: string;
}

// ─── Geração de ocorrências (mesma lógica do cron) ───────────────────────────

const DOW_TO_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

function getOccurrences(
  contract: { frequency: string; weekdays: number[] | null; interval_days: number; schedule_days: ScheduleDay[]; starts_on: string; ends_on: string | null },
  monthStart: Date,
  monthEnd: Date,
): Array<{ date: Date; schedule: ScheduleDay }> {
  const results: Array<{ date: Date; schedule: ScheduleDay }> = [];
  const defaultSchedule = contract.schedule_days?.[0];
  if (!defaultSchedule) return [];

  const contractStart = new Date(contract.starts_on + "T00:00:00");
  const contractEnd = contract.ends_on ? new Date(contract.ends_on + "T23:59:59") : null;

  function inRange(d: Date) {
    return d >= monthStart && d <= monthEnd && d >= contractStart && (!contractEnd || d <= contractEnd);
  }

  if (contract.frequency === "daily") {
    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      if (inRange(cursor)) results.push({ date: new Date(cursor), schedule: defaultSchedule });
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (contract.frequency === "weekly" || contract.frequency === "biweekly") {
    const weekdays = contract.weekdays ?? [];
    const startWeekNum = Math.floor(contractStart.getTime() / (7 * 24 * 3600 * 1000));
    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      const dow = cursor.getDay();
      if (weekdays.includes(dow)) {
        if (contract.frequency === "biweekly") {
          const thisWeekNum = Math.floor(cursor.getTime() / (7 * 24 * 3600 * 1000));
          if ((thisWeekNum - startWeekNum) % 2 !== 0) { cursor.setDate(cursor.getDate() + 1); continue; }
        }
        if (inRange(cursor)) {
          const dayKey = DOW_TO_KEY[dow];
          const schedule = contract.schedule_days.find((s) => s.day === dayKey) ?? defaultSchedule;
          results.push({ date: new Date(cursor), schedule });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (contract.frequency === "monthly") {
    const dayOfMonth = contractStart.getDate();
    const target = new Date(monthStart.getFullYear(), monthStart.getMonth(), dayOfMonth);
    if (inRange(target)) results.push({ date: target, schedule: defaultSchedule });
  } else if (contract.frequency === "custom") {
    const step = Math.max(1, contract.interval_days ?? 1);
    const cursor = new Date(contractStart);
    while (cursor <= monthEnd) {
      if (inRange(cursor)) results.push({ date: new Date(cursor), schedule: defaultSchedule });
      cursor.setDate(cursor.getDate() + step);
    }
  }
  return results;
}

function addMins(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.min(Math.floor(total / 60), 23)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function generateServicesForContract(
  admin: ReturnType<typeof createAdminClient>,
  contractId: string,
  companyId: string,
  locationId: string,
  hourlyRate: number | null,
  contract: Parameters<typeof getOccurrences>[0],
) {
  const now = new Date();
  // Generate from today until end of next 2 months
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 3, 0, 23, 59, 59);

  const { count: existing } = await admin
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId);
  let counter = existing ?? 0;

  const occurrences = getOccurrences(contract, rangeStart, rangeEnd);

  for (const { date, schedule } of occurrences) {
    const dateStr = date.toISOString().split("T")[0];

    const { data: dup } = await admin
      .from("services")
      .select("id")
      .eq("contract_id", contractId)
      .gte("scheduled_start", `${dateStr}T00:00:00`)
      .lte("scheduled_start", `${dateStr}T23:59:59`)
      .maybeSingle();
    if (dup) continue;

    const endTime = addMins(schedule.start_time, schedule.duration_min);
    const calculatedValue =
      hourlyRate != null
        ? parseFloat(((schedule.duration_min / 60) * hourlyRate).toFixed(2))
        : null;

    counter++;
    await admin.from("services").insert({
      company_id: companyId,
      location_id: locationId,
      team_id: schedule.team_id || null,
      contract_id: contractId,
      reference_number: String(counter).padStart(4, "0"),
      scheduled_start: `${dateStr}T${schedule.start_time}:00`,
      scheduled_end: `${dateStr}T${endTime}:00`,
      hourly_rate: hourlyRate,
      calculated_value: calculatedValue,
      status: "agendado",
    });
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function createContrato(input: ContratoInput) {
  const admin = createAdminClient();

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
      company_id: input.company_id,
      created_by: input.created_by,
    })
    .select("id, location_id, locations(hourly_rate)")
    .single();

  if (error) return { ok: false as const, error: error.message };

  // Gerar serviços imediatamente para os próximos 3 meses
  if (input.status === "ativo") {
    const hourlyRate =
      (contract.locations as unknown as { hourly_rate: number | null } | null)?.hourly_rate ?? null;

    await generateServicesForContract(
      admin,
      contract.id,
      input.company_id,
      input.location_id,
      hourlyRate,
      {
        frequency: input.frequency,
        weekdays: input.weekdays,
        interval_days: input.interval_days,
        schedule_days: input.schedule_days,
        starts_on: input.starts_on,
        ends_on: input.ends_on || null,
      },
    );
  }

  revalidatePath("/dashboard/contratos");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}

export async function updateContrato(id: string, input: Omit<ContratoInput, "company_id" | "created_by">) {
  const admin = createAdminClient();

  const { error } = await admin.from("contracts").update({
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
  }).eq("id", id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/contratos");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}
