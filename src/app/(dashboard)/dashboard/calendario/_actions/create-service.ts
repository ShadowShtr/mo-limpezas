"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface CreateServiceInput {
  companyId: string;
  locationId: string;
  teamId: string | null;
  referenceNumber: string;
  scheduledStart: string;
  scheduledEnd: string;
  hourlyRate: number | null;
  calculatedValue: number | null;
  notes: string | null;
}

export async function createService(
  input: CreateServiceInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("services")
    .insert({
      company_id: input.companyId,
      location_id: input.locationId,
      team_id: input.teamId ?? null,
      reference_number: input.referenceNumber,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      status: "agendado",
      hourly_rate: input.hourlyRate,
      calculated_value: input.calculatedValue,
      notes: input.notes,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao criar serviço" };

  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard/mapa");
  revalidatePath("/dashboard");

  return { ok: true, id: data.id };
}
