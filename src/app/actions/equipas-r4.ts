"use server";

// ============================================================================
// Equipas R4 — o dia e a equipa permanente, cada um numa transação só
// ============================================================================
//
// 🔴 O que estas actions substituem, e porquê.
//
//    `moveCollaboratorToTeam` escrevia a meio do arrasto, e escrevia
//    PERMANENTE: fechava pertenças, fazia upsert na equipa de destino, apagava
//    TODAS as reatribuições diárias da pessoa, e notificava-a. Um gesto
//    exploratório no calendário mudava a composição das equipas e mandava uma
//    notificação para o telemóvel de alguém.
//
//    `saveEquipa` fazia `DELETE ALL` + `INSERT ALL` em `team_members`, em
//    operações separadas. Quem saía desaparecia do histórico; quem ficava
//    perdia o `joined_at` verdadeiro; e uma falha entre as duas deixava a
//    equipa vazia.
//
//    Aqui, cada save é uma chamada a uma RPC, e a RPC é uma transação.
//
// 🔴 As notificações vêm SEMPRE depois do commit. Uma falha de push não pode
//    transformar uma gravação confirmada em estado ambíguo — e não pode
//    reverter nada, porque já foi gravado.
// ============================================================================

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";
import { resolverActorEquipas } from "@/lib/equipas/actor";
import { notifyDayTeam } from "@/app/actions/vehicles";
import {
  CONFLITO_DIA,
  CONFLITO_EQUIPA,
  type DiaAlocacoes,
  type OverrideDia,
  type ViaturaDia,
} from "@/lib/equipas/tipos";

export type ResultadoEquipas<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; conflito?: boolean };

/** Lê o dia inteiro: quem está onde, porquê, e as viaturas. */
export async function carregarDia(
  companyId: string,
  date: string,
): Promise<ResultadoEquipas<{ dia: DiaAlocacoes }>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const admin = createAdminClient();

    const resolucao = await resolverActorEquipas(admin, user?.id);
    if (!resolucao.ok) return { ok: false, error: resolucao.error };
    if (resolucao.actor.companyId !== companyId) {
      return { ok: false, error: "Empresa inválida." };
    }

    const [efetiva, snapshot, equipas, pessoas, viaturas, alocacoes] = await Promise.all([
      admin.rpc("team_day_effective", { p_company_id: companyId, p_date: date }),
      admin.rpc("team_day_snapshot", { p_company_id: companyId, p_date: date }),
      admin.from("teams").select("id, name, color, revision")
        .eq("company_id", companyId).eq("active", true).order("name"),
      admin.from("profiles").select("id, full_name, avatar_url")
        .eq("company_id", companyId).eq("status", "ativo").eq("role", "colaborador").order("full_name"),
      admin.from("vehicles").select("id, model, plate")
        .eq("company_id", companyId).eq("status", "ativo").order("model"),
      admin.from("vehicle_allocations").select("team_id, vehicle_id, driver_id")
        .eq("company_id", companyId).eq("date", date),
    ]);

    if (efetiva.error) return { ok: false, error: efetiva.error.message };
    if (snapshot.error) return { ok: false, error: snapshot.error.message };
    if (equipas.error) return { ok: false, error: equipas.error.message };
    if (pessoas.error) return { ok: false, error: pessoas.error.message };
    if (viaturas.error) return { ok: false, error: viaturas.error.message };
    if (alocacoes.error) return { ok: false, error: alocacoes.error.message };

    return {
      ok: true,
      dia: {
        date,
        snapshot: (snapshot.data as string) ?? "",
        equipas: (equipas.data ?? []) as DiaAlocacoes["equipas"],
        pessoas: (pessoas.data ?? []) as DiaAlocacoes["pessoas"],
        viaturasDisponiveis: (viaturas.data ?? []) as DiaAlocacoes["viaturasDisponiveis"],
        efetiva: (efetiva.data ?? []) as DiaAlocacoes["efetiva"],
        viaturas: (alocacoes.data ?? []) as ViaturaDia[],
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao carregar o dia." };
  }
}

/**
 * Guarda o dia inteiro. UMA chamada, UMA transação.
 *
 * 🔴 `expectedSnapshot` é o token de concorrência. Sem ele isto seria
 *    last-write-wins, e o segundo gestor apagaria o trabalho do primeiro sem
 *    que nenhum dos dois desse por isso.
 */
export async function guardarDiaEquipas(input: {
  companyId: string;
  date: string;
  expectedSnapshot: string;
  overrides: OverrideDia[];
  viaturas: ViaturaDia[];
}): Promise<ResultadoEquipas<{ snapshot: string }>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const admin = createAdminClient();

    const resolucao = await resolverActorEquipas(admin, user?.id);
    if (!resolucao.ok) return { ok: false, error: resolucao.error };
    const { actor } = resolucao;
    if (actor.companyId !== input.companyId) {
      return { ok: false, error: "Empresa inválida." };
    }

    // Estado anterior, só para saber a quem avisar DEPOIS do commit.
    const { data: antes } = await admin.rpc("team_day_effective", {
      p_company_id: input.companyId, p_date: input.date,
    });

    const { data, error } = await admin.rpc("save_team_day_allocations_atomic", {
      p_company_id: input.companyId,
      p_date: input.date,
      p_actor: actor.profileId,
      p_expected_snapshot: input.expectedSnapshot,
      p_overrides: input.overrides,
      p_vehicles: input.viaturas,
    });

    if (error) {
      if (error.message.includes(CONFLITO_DIA)) {
        return {
          ok: false,
          conflito: true,
          error: "Estas alocações foram alteradas por outra pessoa. Atualize para rever antes de guardar.",
        };
      }
      return { ok: false, error: error.message };
    }

    const linha = Array.isArray(data) ? data[0] : data;

    // ── Só a partir daqui: o dia está gravado ───────────────────────────────
    //
    // 🔴 A auditoria e as notificações correm DEPOIS. Se qualquer uma falhar, o
    //    save continua gravado e correcto — é observação, não parte da
    //    operação. O inverso (notificar primeiro) já existiu, e avisava pessoas
    //    de mudanças que podiam nunca chegar a acontecer.
    await auditLog({
      companyId: input.companyId,
      actorId: actor.profileId,
      action: "equipas_dia_alocacoes_guardadas",
      entityType: "team_day",
      entityId: input.date,
      before: { efetiva: antes ?? [] },
      after: { overrides: input.overrides, viaturas: input.viaturas },
      source: "dashboard",
    }, admin).catch(() => null);

    // 🔴 Avisar só quem MUDOU mesmo, e só depois do commit.
    //
    //    Compara-se a equipa efetiva antes e depois. Antes, cada arrasto
    //    notificava — incluindo os arrastos que a pessoa desfazia a seguir, e
    //    incluindo os que nunca chegavam a ser guardados. Aqui, quem foi
    //    arrastado e voltou ao sítio não recebe nada, porque não mudou nada.
    const antesPorPessoa = new Map<string, string | null>(
      ((antes ?? []) as Array<{ collaborator_id: string; effective_team_id: string | null }>)
        .map((l) => [l.collaborator_id, l.effective_team_id]),
    );

    const { data: depois } = await admin.rpc("team_day_effective", {
      p_company_id: input.companyId, p_date: input.date,
    });

    for (const linhaDepois of ((depois ?? []) as Array<{
      collaborator_id: string; effective_team_id: string | null; ausente: boolean;
    }>)) {
      if (linhaDepois.ausente) continue;
      const anterior = antesPorPessoa.get(linhaDepois.collaborator_id) ?? null;
      if (anterior === linhaDepois.effective_team_id) continue;
      // Sem equipa efetiva não há nome de equipa para anunciar; o stand by
      // explícito não é uma mudança de equipa, é a ausência de uma.
      if (!linhaDepois.effective_team_id) continue;

      // 🔴 `catch` por pessoa. Uma subscrição de push morta não pode impedir o
      //    aviso à pessoa seguinte, e nenhuma delas pode pôr em causa um save
      //    que já está commitado.
      await notifyDayTeam({
        admin,
        companyId: input.companyId,
        collaboratorId: linhaDepois.collaborator_id,
        teamId: linhaDepois.effective_team_id,
        date: input.date,
        isReset: false,
      }).catch(() => false);
    }

    revalidatePath("/dashboard/calendario");
    return { ok: true, snapshot: (linha?.snapshot as string) ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao guardar as alocações." };
  }
}

/**
 * Guarda a equipa permanente.
 *
 * 🔴 `expectedRevision` + `expectedMembers`, e não só a revisão: a revisão
 *    acompanha `teams`, e a composição vive em `team_members`. Alguém pode
 *    acrescentar uma pessoa sem tocar na linha da equipa.
 */
export async function guardarEquipaPermanente(input: {
  companyId: string;
  teamId: string | null;
  expectedRevision: number | null;
  expectedMembers: string[];
  name: string;
  color: string;
  active: boolean;
  leaderId: string | null;
  memberIds: string[];
}): Promise<ResultadoEquipas<{ teamId: string; revision: number }>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const admin = createAdminClient();

    const resolucao = await resolverActorEquipas(admin, user?.id);
    if (!resolucao.ok) return { ok: false, error: resolucao.error };
    const { actor } = resolucao;
    if (actor.companyId !== input.companyId) {
      return { ok: false, error: "Empresa inválida." };
    }

    const { data, error } = await admin.rpc("save_permanent_team_atomic", {
      p_company_id: input.companyId,
      p_actor: actor.profileId,
      p_team_id: input.teamId,
      p_expected_revision: input.expectedRevision,
      p_expected_members: input.expectedMembers,
      p_name: input.name,
      p_color: input.color,
      p_active: input.active,
      p_leader_id: input.leaderId,
      p_members: input.memberIds,
    });

    if (error) {
      if (error.message.includes(CONFLITO_EQUIPA)) {
        return {
          ok: false,
          conflito: true,
          error: "Esta equipa foi alterada por outra pessoa. Atualize para rever antes de guardar.",
        };
      }
      return { ok: false, error: error.message };
    }

    const linha = Array.isArray(data) ? data[0] : data;

    await auditLog({
      companyId: input.companyId,
      actorId: actor.profileId,
      action: "equipa_permanente_guardada",
      entityType: "team",
      entityId: (linha?.out_team_id as string) ?? "",
      before: { memberIds: input.expectedMembers, revision: input.expectedRevision },
      after: { memberIds: input.memberIds, name: input.name },
      source: "dashboard",
    }, admin).catch(() => null);

    // 🔴 Reler a fonte canónica. O cartão da aba Equipas conta pertenças
    //    activas — corrigir só o estado local do React deixaria o cartão a
    //    dizer 2 enquanto a folha mostra 1, que é exactamente o defeito
    //    relatado.
    revalidatePath("/dashboard/equipas");
    revalidatePath("/dashboard/calendario");

    return {
      ok: true,
      teamId: (linha?.out_team_id as string) ?? "",
      revision: Number(linha?.out_revision ?? 0),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao guardar a equipa." };
  }
}

/**
 * Arquiva a equipa. Nunca apaga.
 *
 * 🔴 `DELETE FROM teams` levava atrás, por CASCADE, o histórico inteiro de
 *    `team_members` e de `vehicle_allocations`, e punha `services.team_id` a
 *    NULL — um serviço antigo deixava de saber quem o fez.
 */
export async function arquivarEquipa(
  companyId: string,
  teamId: string,
): Promise<ResultadoEquipas<{ membershipsEncerradas: number }>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const admin = createAdminClient();

    const resolucao = await resolverActorEquipas(admin, user?.id);
    if (!resolucao.ok) return { ok: false, error: resolucao.error };
    const { actor } = resolucao;
    if (actor.companyId !== companyId) return { ok: false, error: "Empresa inválida." };

    const { data, error } = await admin.rpc("archive_team_atomic", {
      p_company_id: companyId,
      p_actor: actor.profileId,
      p_team_id: teamId,
    });
    if (error) return { ok: false, error: error.message };

    const linha = Array.isArray(data) ? data[0] : data;

    await auditLog({
      companyId,
      actorId: actor.profileId,
      action: "equipa_arquivada",
      entityType: "team",
      entityId: teamId,
      before: { active: true },
      after: { active: false, membershipsEncerradas: linha?.memberships_encerradas ?? 0 },
      source: "dashboard",
    }, admin).catch(() => null);

    revalidatePath("/dashboard/equipas");
    revalidatePath("/dashboard/calendario");
    return { ok: true, membershipsEncerradas: Number(linha?.memberships_encerradas ?? 0) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao arquivar a equipa." };
  }
}
