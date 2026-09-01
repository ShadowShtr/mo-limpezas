"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { logQueryFailure } from "@/lib/query-error";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type VehicleStatus = "ativo" | "manutencao" | "inativo";

export interface Vehicle {
  id: string;
  company_id: string;
  model: string;
  plate: string;
  status: VehicleStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleAllocation {
  id: string;
  vehicle_id: string;
  team_id: string;
  driver_id: string | null;
  date: string;
  vehicle?: Vehicle;
  driver?: { id: string; full_name: string } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCompanyId(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Não autenticado");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();

  if (!profile) throw new Error("Perfil não encontrado");
  return profile.company_id;
}

// ─── Viaturas — CRUD ──────────────────────────────────────────────────────────

export async function getVehicles() {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("vehicles")
    .select("*")
    .eq("company_id", companyId)
    .order("model");

  if (error) throw error;
  return data as Vehicle[];
}

export async function getActiveVehicles() {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("vehicles")
    .select("id, model, plate, status")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .order("model");

  if (error) throw error;
  return data as Pick<Vehicle, "id" | "model" | "plate" | "status">[];
}

export async function createVehicle(input: {
  model: string;
  plate: string;
  status: VehicleStatus;
  notes?: string;
}) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { error } = await admin.from("vehicles").insert({
    company_id: companyId,
    model: input.model.trim(),
    plate: input.plate.trim().toUpperCase(),
    status: input.status,
    notes: input.notes?.trim() || null,
  });

  if (error) throw error;
  revalidatePath("/dashboard/viaturas");
}

export async function updateVehicle(id: string, input: {
  model?: string;
  plate?: string;
  status?: VehicleStatus;
  notes?: string | null;
}) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const patch: { model?: string; plate?: string; status?: string; notes?: string | null } = {};
  if (input.model !== undefined) patch.model = input.model.trim();
  if (input.plate !== undefined) patch.plate = input.plate.trim().toUpperCase();
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  const { error } = await admin
    .from("vehicles")
    .update(patch)
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw error;
  revalidatePath("/dashboard/viaturas");
}

export async function deleteVehicle(id: string) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { error } = await admin
    .from("vehicles")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw error;
  revalidatePath("/dashboard/viaturas");
}

// ─── Alocações diárias ────────────────────────────────────────────────────────

export async function getAllocationsForDate(date: string) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("vehicle_allocations")
    .select(`
      id, vehicle_id, team_id, driver_id, date,
      vehicle:vehicles(id, model, plate),
      driver:profiles(id, full_name)
    `)
    .eq("company_id", companyId)
    .eq("date", date);

  if (error) throw error;
  return data as unknown as VehicleAllocation[];
}

// ─── Trocar colaboradoras de equipa por dia ─────────────────────────────────────

export interface DayTeamAssignment {
  collaborator_id: string;
  team_id: string;
}

/** Lê as reatribuições do dia (colaboradora → equipa com que trabalha hoje). */
export async function getDayTeamAssignmentsForDate(date: string): Promise<DayTeamAssignment[]> {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("collaborator_ride_assignments")
    .select("collaborator_id, team_id")
    .eq("company_id", companyId)
    .eq("date", date);

  if (error) throw error;
  return (data ?? []) as DayTeamAssignment[];
}

/**
 * Move uma colaboradora para a equipa `teamId` apenas nesse dia e avisa-a no
 * telemóvel (push + notificação in-app). Se `teamId` for a equipa de origem
 * (`homeTeamId`), remove a reatribuição — volta à sua equipa.
 * Nunca lança: devolve sempre `{ ok }`.
 */
// ============================================================================
// `moveCollaboratorToTeam` foi REMOVIDA (Equipas R4)
// ============================================================================
//
// 🔴 Escrevia a meio do arrasto, e escrevia PERMANENTE. Fechava a pertença
//    ativa noutras equipas, fazia upsert na de destino, **apagava todas as
//    reatribuições diárias da colaboradora** — decisões operacionais já
//    tomadas para outros dias — e notificava-a no telemóvel. Tudo isto por um
//    gesto, antes de alguém carregar em «Guardar alocações».
//
//    Foi substituída por `save_team_day_allocations_atomic` (o dia, numa
//    transação, sem tocar na composição permanente) e
//    `save_permanent_team_atomic` (a equipa permanente, com histórico e token
//    de concorrência), ambas em `src/app/actions/equipas-r4.ts`.
//
// 🔴 Não fica cá «por precaução». Uma função exportada que reescreve
//    `team_members` e apaga overrides continua a ser uma capacidade de escrita
//    real, mesmo sem chamadores — e uma capacidade sem chamador é exactamente
//    a que ninguém revê. O inventário de escrita deste repositório existe por
//    causa de um caso destes.

/**
 * Avisa a colaboradora (in-app + web push) da equipa com que trabalha nesse dia.
 *
 * 🔴 Passou a ser exportada, e o momento em que é chamada mudou. Antes corria
 *    dentro do fluxo do arrasto — uma pessoa era avisada de uma mudança que
 *    ninguém tinha confirmado. Agora só é chamada DEPOIS do batch do dia estar
 *    commitado, por `guardarDiaEquipas`, e uma falha aqui não pode desfazer o
 *    que já ficou gravado.
 */
export async function notifyDayTeam(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any;
  companyId: string;
  collaboratorId: string;
  teamId: string;
  date: string;
  isReset: boolean;
}): Promise<boolean> {
  const { admin, companyId, collaboratorId, teamId, date, isReset } = args;

  const [{ data: team }, { data: alloc }] = await Promise.all([
    admin.from("teams").select("name").eq("id", teamId).single(),
    admin
      .from("vehicle_allocations")
      .select("vehicles(model, plate)")
      .eq("company_id", companyId)
      .eq("team_id", teamId)
      .eq("date", date)
      .maybeSingle(),
  ]);

  const vehicle = alloc?.vehicles
    ? (Array.isArray(alloc.vehicles) ? alloc.vehicles[0] : alloc.vehicles)
    : null;
  const vehicleLabel = vehicle ? `${vehicle.model} (${vehicle.plate})` : null;
  const teamName = team?.name ?? "outra equipa";

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("pt-PT", {
    day: "2-digit", month: "2-digit",
  });

  const title = "🔄 Mudança de equipa";
  const body = isReset
    ? `${dateLabel}: voltas à tua equipa.`
    : `${dateLabel}: trabalhas com a equipa ${teamName}${vehicleLabel ? ` (viatura ${vehicleLabel})` : ""}.`;

  await admin.from("notifications").insert({
    company_id: companyId,
    user_id: collaboratorId,
    type: "team_change",
    title,
    body,
    data: { team_id: teamId, date },
  }).then(() => null, () => null);

  const { data: subs, error: subsError } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", collaboratorId)
    .eq("company_id", companyId);

  // Auxiliar: a função já devolve "avisou?". `false` por falha é a resposta
  // certa — o que faltava era o registo de que houve falha.
  if (subsError) {
    logQueryFailure("notifyDayTeam:subscriptions", subsError);
    return false;
  }
  if (!subs?.length) return false;

  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webpushMod = ((await import("web-push")) as any).default ?? (await import("web-push"));
    webpushMod.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);

    const payload = JSON.stringify({ title, body, url: "/app" });
    const results = await Promise.allSettled(
      subs.map((s: { endpoint: string; p256dh: string; auth_key: string }) =>
        webpushMod.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        ),
      ),
    );
    return results.some((r) => r.status === "fulfilled");
  } catch (err) {
    console.error("[notifyDayTeam] push falhou:", err);
    return false;
  }
}
