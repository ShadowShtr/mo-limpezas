"use server";

import { z } from "zod";
import { AUTH_GUARD_CODES, requireProfile } from "@/lib/auth-guard";
import { revalidateBusinessPaths } from "@/lib/revalidate-business";
import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  validationFailure,
  type ActionResult,
} from "@/lib/action-result";

const settingsSchema = z.object({
  vat_rate: z.number().min(0, "IVA não pode ser negativo.").max(100, "IVA não pode exceder 100%."),
  invoice_prefix: z.string().min(1).max(10).trim(),
  hourly_rate: z.number().min(0.01, "Taxa horária deve ser positiva.").max(999),
  meal_allowance_day: z.number().min(0).max(100),
  overtime_rate_pct: z.number().min(0).max(200),
  vacation_days_year: z.number().int().min(0).max(365),
  gps_radius_meters: z.number().int().min(10, "Raio GPS deve ser pelo menos 10m.").max(50_000),
  timezone: z.string().min(1).max(50),
  checkin_before_minutes: z.number().int().min(0, "Não pode ser negativo.").max(480, "Máximo 480 minutos (8h)."),
  checkout_after_minutes: z.number().int().min(0, "Não pode ser negativo.").max(480, "Máximo 480 minutos (8h)."),
});

export interface CompanySettings {
  vat_rate: number;
  invoice_prefix: string;
  hourly_rate: number;
  meal_allowance_day: number;
  overtime_rate_pct: number;
  vacation_days_year: number;
  gps_radius_meters: number;
  timezone: string;
  checkin_before_minutes: number;
  checkout_after_minutes: number;
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
  checkin_before_minutes: 40,
  checkout_after_minutes: 60,
};

export async function getCompanySettings(_companyId?: string): Promise<CompanySettings> {
  const guard = await requireProfile();
  if (!guard.ok) return DEFAULTS;
  const { admin } = guard;
  const { data } = await admin
    .from("company_settings")
    .select("vat_rate, invoice_prefix, hourly_rate, meal_allowance_day, overtime_rate_pct, vacation_days_year, gps_radius_meters, timezone, checkin_before_minutes, checkout_after_minutes")
    .eq("company_id", guard.profile.company_id)
    .single();

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
    checkin_before_minutes: data.checkin_before_minutes ?? DEFAULTS.checkin_before_minutes,
    checkout_after_minutes: data.checkout_after_minutes ?? DEFAULTS.checkout_after_minutes,
  };
}

/**
 * PILOTO da Task T05 — primeira action no formato único de `ActionResult`.
 *
 * Escolhida por ser a mais isolada que o inventário encontrou: escreve numa
 * única tabela, sem transação, sem cron, sem tocar em contratos, calendário
 * ou faturação, e com **um** consumidor (`settings-form.tsx`), migrado na
 * mesma alteração.
 *
 * As mensagens visíveis ao utilizador são exatamente as de antes. A única
 * mudança de comportamento é deliberada e corrige um defeito: a falha de
 * escrita devolvia `error.message` do Supabase diretamente ao ecrã.
 *
 * Ver `src/lib/action-result.ts` para a estratégia de adoção gradual.
 */
export async function saveCompanySettings(
  settings: CompanySettings,
): Promise<ActionResult<CompanySettings>> {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  // Sessão, perfil, empresa e papel numa só chamada. O `company_id` vem
  // sempre da sessão — nunca do formulário nem de nada que o browser controle.
  const guard = await requireProfile({ roles: ["admin", "gestor"] });

  if (!guard.ok) {
    // Ramificação por código estável, nunca pelo texto de `guard.error`: a
    // mensagem que o utilizador deve ver depende da action.
    if (guard.code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
      return actionFailure(
        ACTION_ERROR_CODES.UNAUTHENTICATED,
        "Não autenticado.",
      );
    }

    if (guard.code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
      return actionFailure(
        ACTION_ERROR_CODES.NOT_FOUND,
        "Perfil não encontrado.",
      );
    }

    return actionFailure(
      ACTION_ERROR_CODES.FORBIDDEN,
      "Sem permissão para alterar configurações.",
    );
  }

  const { admin } = guard;
  const company_id = guard.profile.company_id;

  const { error } = await admin
    .from("company_settings")
    .upsert(
      {
        company_id,
        vat_rate: parsed.data.vat_rate,
        invoice_prefix: parsed.data.invoice_prefix,
        hourly_rate: parsed.data.hourly_rate,
        meal_allowance_day: parsed.data.meal_allowance_day,
        overtime_rate_pct: parsed.data.overtime_rate_pct,
        vacation_days_year: parsed.data.vacation_days_year,
        gps_radius_meters: parsed.data.gps_radius_meters,
        timezone: parsed.data.timezone,
        checkin_before_minutes: parsed.data.checkin_before_minutes,
        checkout_after_minutes: parsed.data.checkout_after_minutes,
      },
      { onConflict: "company_id" },
    );

  if (error) {
    // Antes: `error.message` do Supabase ia direto para o ecrã, expondo nomes
    // de tabelas e restrições a quem não tem nada com isso — e sem ajudar o
    // utilizador. O detalhe real passa a ficar no log do servidor.
    return internalFailure(
      "saveCompanySettings",
      error,
      ACTION_ERROR_CODES.PERSISTENCE,
    );
  }

  // Matriz central, em vez de duas chamadas diretas: as rotas afetadas por
  // uma alteração de configurações passam a estar declaradas num só sítio.
  revalidateBusinessPaths({ scopes: ["configuracoes", "relatorios"] });

  return actionSuccess(parsed.data);
}
