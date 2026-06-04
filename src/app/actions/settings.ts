"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface CompanySettings {
  vat_rate: number;
  invoice_prefix: string;
  hourly_rate: number;
  meal_allowance_day: number;
  overtime_rate_pct: number;
  vacation_days_year: number;
  gps_radius_meters: number;
  timezone: string;
}

const DEFAULTS: CompanySettings = {
  vat_rate: 23,
  invoice_prefix: "F",
  hourly_rate: 8.0,
  meal_allowance_day: 9.6,
  overtime_rate_pct: 25,
  vacation_days_year: 22,
  gps_radius_meters: 200,
  timezone: "Europe/Lisbon",
};

export async function getCompanySettings(companyId: string): Promise<CompanySettings> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("company_settings")
    .select("vat_rate, invoice_prefix, hourly_rate, meal_allowance_day, overtime_rate_pct, vacation_days_year, gps_radius_meters, timezone")
    .eq("company_id", companyId)
    .single() as { data: Partial<CompanySettings> | null };

  if (!data) return DEFAULTS;

  return {
    vat_rate: data.vat_rate ?? DEFAULTS.vat_rate,
    invoice_prefix: data.invoice_prefix ?? DEFAULTS.invoice_prefix,
    hourly_rate: data.hourly_rate ?? DEFAULTS.hourly_rate,
    meal_allowance_day: data.meal_allowance_day ?? DEFAULTS.meal_allowance_day,
    overtime_rate_pct: data.overtime_rate_pct ?? DEFAULTS.overtime_rate_pct,
    vacation_days_year: data.vacation_days_year ?? DEFAULTS.vacation_days_year,
    gps_radius_meters: data.gps_radius_meters ?? DEFAULTS.gps_radius_meters,
    timezone: data.timezone ?? DEFAULTS.timezone,
  };
}

export async function saveCompanySettings(settings: CompanySettings) {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile) return { ok: false as const, error: "Perfil não encontrado." };

  const { company_id, role } = profile;

  if (role !== "admin" && role !== "gestor") {
    return { ok: false as const, error: "Sem permissão para alterar configurações." };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("company_settings")
    .upsert(
      {
        company_id,
        vat_rate: settings.vat_rate,
        invoice_prefix: settings.invoice_prefix,
        hourly_rate: settings.hourly_rate,
        meal_allowance_day: settings.meal_allowance_day,
        overtime_rate_pct: settings.overtime_rate_pct,
        vacation_days_year: settings.vacation_days_year,
        gps_radius_meters: settings.gps_radius_meters,
        timezone: settings.timezone,
      },
      { onConflict: "company_id" },
    );

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/configuracoes");
  revalidatePath("/dashboard/relatorios");
  return { ok: true as const };
}
