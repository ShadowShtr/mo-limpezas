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

export async function createContrato(input: ContratoInput) {
  const admin = createAdminClient();

  const { error } = await admin.from("contracts").insert({
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
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/contratos");
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
  return { ok: true as const };
}
