// ============================================================================
// Equipas R4 — vocabulário partilhado entre a base, as actions e o ecrã
// ============================================================================

import type { AusenciaDia } from "@/lib/equipas/ausencias";

export const CONFLITO_DIA = "TEAM_ALLOCATION_CONFLICT";
export const CONFLITO_EQUIPA = "TEAM_SAVE_CONFLICT";

export type OrigemEquipaDia =
  | "override_team"
  | "override_standby"
  | "permanent"
  | "sem_equipa";

export interface LinhaEfetiva {
  collaborator_id: string;
  effective_team_id: string | null;
  permanent_team_id: string | null;
  origem: OrigemEquipaDia;
  ausente: boolean;
}

export interface EquipaBase {
  id: string;
  name: string;
  color: string;
  revision: number;
}

export interface PessoaBase {
  id: string;
  full_name: string;
  avatar_url: string | null;
}

export interface ViaturaBase {
  id: string;
  model: string;
  plate: string;
}

export interface OverrideDia {
  collaborator_id: string;
  /** `null` = stand by explícito nesse dia. Ausência da entrada = sem decisão. */
  team_id: string | null;
}

export interface ViaturaDia {
  team_id: string;
  vehicle_id: string;
  driver_id: string | null;
}

export interface DiaAlocacoes {
  date: string;
  snapshot: string;
  equipas: EquipaBase[];
  pessoas: PessoaBase[];
  viaturasDisponiveis: ViaturaBase[];
  efetiva: LinhaEfetiva[];
  viaturas: ViaturaDia[];
  /** Opcional para não alterar o contrato do modal R4; a vista espelho enriquece-o. */
  ausencias?: AusenciaDia[];
}

export interface Rascunho {
  /** collaboratorId → equipa desse dia, ou `null` para stand by explícito. */
  overrides: Record<string, string | null>;
  /** teamId → viatura e condutora. */
  viaturas: Record<string, { vehicleId: string; driverId: string }>;
}

export function rascunhoInicial(dia: DiaAlocacoes): Rascunho {
  const overrides: Record<string, string | null> = {};
  for (const linha of dia.efetiva) {
    if (linha.origem === "override_team") overrides[linha.collaborator_id] = linha.effective_team_id;
    else if (linha.origem === "override_standby") overrides[linha.collaborator_id] = null;
  }

  const viaturas: Record<string, { vehicleId: string; driverId: string }> = {};
  for (const vehicle of dia.viaturas) {
    viaturas[vehicle.team_id] = { vehicleId: vehicle.vehicle_id, driverId: vehicle.driver_id ?? "" };
  }

  return { overrides, viaturas };
}

export function equipaEfetivaNoRascunho(
  rascunho: Rascunho,
  linha: LinhaEfetiva,
): string | null {
  if (Object.prototype.hasOwnProperty.call(rascunho.overrides, linha.collaborator_id)) {
    return rascunho.overrides[linha.collaborator_id];
  }
  return linha.permanent_team_id;
}

export function rascunhoSujo(inicial: Rascunho, actual: Rascunho): boolean {
  return JSON.stringify(normalizar(inicial)) !== JSON.stringify(normalizar(actual));
}

function normalizar(rascunho: Rascunho) {
  return {
    overrides: Object.keys(rascunho.overrides).sort().map((key) => [key, rascunho.overrides[key]]),
    viaturas: Object.keys(rascunho.viaturas).sort()
      .filter((key) => rascunho.viaturas[key]?.vehicleId)
      .map((key) => [key, rascunho.viaturas[key].vehicleId, rascunho.viaturas[key].driverId || ""]),
  };
}

export function rascunhoParaEscrita(rascunho: Rascunho): {
  overrides: OverrideDia[];
  viaturas: ViaturaDia[];
} {
  return {
    overrides: Object.entries(rascunho.overrides).map(([collaborator_id, team_id]) => ({
      collaborator_id,
      team_id,
    })),
    viaturas: Object.entries(rascunho.viaturas)
      .filter(([, vehicle]) => Boolean(vehicle.vehicleId))
      .map(([team_id, vehicle]) => ({
        team_id,
        vehicle_id: vehicle.vehicleId,
        driver_id: vehicle.driverId || null,
      })),
  };
}
