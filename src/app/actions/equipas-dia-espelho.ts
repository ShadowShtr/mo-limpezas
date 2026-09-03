"use server";

import { carregarDia, type ResultadoEquipas } from "@/app/actions/equipas-r4";
import { requireProfile } from "@/lib/auth-guard";
import type { DiaAlocacoes } from "@/lib/equipas/tipos";
import type { AusenciaDia } from "@/lib/equipas/ausencias";

/**
 * Read model ESPELHO: a equipa efetiva vem de `carregarDia`/`team_day_effective`,
 * exatamente a mesma fonte do modal do Calendário. Só enriquecemos a linha
 * `ausente` com tipo e datas; não calculamos equipa outra vez.
 */
export async function carregarDiaEspelho(
  companyId: string,
  date: string,
): Promise<ResultadoEquipas<{ dia: DiaAlocacoes & { ausencias: AusenciaDia[] } }>> {
  const base = await carregarDia(companyId, date);
  if (!base.ok) return base;

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  if (guard.profile.company_id !== companyId) return { ok: false, error: "Empresa inválida." };

  const { data, error } = await guard.admin
    .from("absences")
    .select("collaborator_id, absence_type, starts_on, ends_on")
    .eq("company_id", companyId)
    .lte("starts_on", date)
    .gte("ends_on", date)
    .order("starts_on", { ascending: true });

  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    dia: {
      ...base.dia,
      ausencias: (data ?? []) as AusenciaDia[],
    },
  };
}
