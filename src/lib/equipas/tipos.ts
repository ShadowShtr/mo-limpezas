// ============================================================================
// Equipas R4 — vocabulário partilhado entre a base, as actions e o ecrã
// ============================================================================
//
// Ficheiro sem `"use server"` de propósito: uma action só pode exportar
// funções assíncronas, e estes tipos e constantes têm de ser importáveis pelo
// cliente. O projeto já apanhou este erro uma vez, com `CANCEL_TYPE_LABELS`.
// ============================================================================

/** Os códigos que as RPC levantam. Comparados por texto, uma só vez. */
export const CONFLITO_DIA = "TEAM_ALLOCATION_CONFLICT";
export const CONFLITO_EQUIPA = "TEAM_SAVE_CONFLICT";

/**
 * De onde vem a equipa efetiva de uma pessoa num dia.
 *
 * 🔴 `override_standby` e `sem_equipa` aparecem na MESMA caixa do ecrã —
 *    Disponível — e não são a mesma coisa:
 *
 *      `override_standby` alguém decidiu, para este dia, que ela não sai.
 *                         Continua na equipa permanente.
 *      `sem_equipa`       não tem equipa nenhuma, e ninguém decidiu nada.
 *
 *    Perder esta diferença no modelo é perder a diferença entre uma decisão e
 *    a ausência de decisão. No ecrã pode ser um badge discreto; nos dados é
 *    obrigatório.
 */
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

/** Uma linha de `collaborator_ride_assignments` a escrever. */
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
  /** Token de concorrência. Vai de volta no save e é comparado sob lock. */
  snapshot: string;
  equipas: EquipaBase[];
  pessoas: PessoaBase[];
  viaturasDisponiveis: ViaturaBase[];
  efetiva: LinhaEfetiva[];
  viaturas: ViaturaDia[];
}

// ─── O rascunho, que é o que o ecrã manipula ────────────────────────────────
//
// 🔴 O rascunho NUNCA toca na base. É a diferença entre «arrastei para ver» e
//    «decidi». Enquanto o utilizador arrasta, só isto muda.

export interface Rascunho {
  /** collaboratorId → equipa desse dia, ou `null` para stand by explícito. */
  overrides: Record<string, string | null>;
  /** teamId → viatura e condutora. */
  viaturas: Record<string, { vehicleId: string; driverId: string }>;
}

/**
 * O rascunho inicial, lido do estado actual da base.
 *
 * Só entram overrides que EXISTEM como linha. Uma pessoa que esteja na equipa
 * permanente e sem decisão para o dia não aparece aqui — e é isso que
 * distingue «sem decisão» de «decidido que fica de fora».
 */
export function rascunhoInicial(dia: DiaAlocacoes): Rascunho {
  const overrides: Record<string, string | null> = {};
  for (const linha of dia.efetiva) {
    if (linha.origem === "override_team") overrides[linha.collaborator_id] = linha.effective_team_id;
    else if (linha.origem === "override_standby") overrides[linha.collaborator_id] = null;
  }

  const viaturas: Record<string, { vehicleId: string; driverId: string }> = {};
  for (const v of dia.viaturas) {
    viaturas[v.team_id] = { vehicleId: v.vehicle_id, driverId: v.driver_id ?? "" };
  }

  return { overrides, viaturas };
}

/**
 * A equipa efetiva de uma pessoa SEGUNDO O RASCUNHO.
 *
 * 🔴 A mesma regra de precedência da `team_day_effective` em SQL. Existe aqui
 *    porque o ecrã tem de a aplicar sobre alterações que ainda não estão na
 *    base — e há um teste que compara as duas implementações contra os mesmos
 *    casos, porque duas cópias de uma regra divergem sempre.
 */
export function equipaEfetivaNoRascunho(
  rascunho: Rascunho,
  linha: LinhaEfetiva,
): string | null {
  if (Object.prototype.hasOwnProperty.call(rascunho.overrides, linha.collaborator_id)) {
    return rascunho.overrides[linha.collaborator_id];
  }
  return linha.permanent_team_id;
}

/** O rascunho tem alterações por guardar? */
export function rascunhoSujo(inicial: Rascunho, actual: Rascunho): boolean {
  return JSON.stringify(normalizar(inicial)) !== JSON.stringify(normalizar(actual));
}

function normalizar(r: Rascunho) {
  return {
    overrides: Object.keys(r.overrides).sort().map((k) => [k, r.overrides[k]]),
    // Uma equipa sem viatura escolhida não é uma alocação: entra e sai do mapa
    // conforme os cliques, e contá-la faria o rascunho parecer sujo sem o estar.
    viaturas: Object.keys(r.viaturas).sort()
      .filter((k) => r.viaturas[k]?.vehicleId)
      .map((k) => [k, r.viaturas[k].vehicleId, r.viaturas[k].driverId || ""]),
  };
}

/**
 * O rascunho, traduzido para o que a RPC escreve.
 *
 * 🔴 A lista de overrides é COMPLETA: o que não vier aqui é apagado para este
 *    dia. É por isso que `null` tem de sobreviver à travessia — um
 *    `filter(Boolean)` distraído transformaria «stand by explícito» em «sem
 *    decisão» e a pessoa voltaria à equipa permanente sem ninguém pedir.
 */
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
      .filter(([, v]) => Boolean(v.vehicleId))
      .map(([team_id, v]) => ({
        team_id,
        vehicle_id: v.vehicleId,
        driver_id: v.driverId || null,
      })),
  };
}
