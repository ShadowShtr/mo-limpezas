"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

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

export async function upsertAllocation(input: {
  vehicle_id: string;
  team_id: string;
  driver_id: string | null;
  date: string;
}) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { error } = await admin
    .from("vehicle_allocations")
    .upsert(
      {
        company_id: companyId,
        vehicle_id: input.vehicle_id,
        team_id: input.team_id,
        driver_id: input.driver_id || null,
        date: input.date,
      },
      { onConflict: "vehicle_id,date" },
    );

  if (error) throw error;
}

export async function removeAllocation(teamId: string, date: string) {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { error } = await admin
    .from("vehicle_allocations")
    .delete()
    .eq("company_id", companyId)
    .eq("team_id", teamId)
    .eq("date", date);

  if (error) throw error;
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
export async function moveCollaboratorToTeam(input: {
  collaboratorId: string;
  teamId: string;
  homeTeamId: string | null;
  date: string;
}): Promise<{ ok: boolean; error?: string; notified?: boolean }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Não autenticado." };

    const admin = createAdminClient();
    const { data: actor } = await admin
      .from("profiles").select("company_id, role").eq("id", user.id).single();
    if (!actor || !["admin", "gestor"].includes(actor.role)) {
      return { ok: false, error: "Sem permissão." };
    }
    const companyId = actor.company_id;

    const { data: collab } = await admin
      .from("profiles").select("id, full_name, company_id").eq("id", input.collaboratorId).single();
    if (!collab || collab.company_id !== companyId) {
      return { ok: false, error: "Colaboradora inválida." };
    }

    // Validar que a equipa de destino é da empresa.
    const { data: targetTeam } = await admin
      .from("teams")
      .select("id")
      .eq("id", input.teamId)
      .eq("company_id", companyId)
      .single();
    if (!targetTeam) return { ok: false, error: "Equipa inválida." };

    // Movimento PERMANENTE: atualiza a composição da equipa (team_members), para
    // que a aba Equipas e o calendário fiquem sempre iguais.
    // 1) Fecha qualquer pertença ativa noutras equipas.
    await admin
      .from("team_members")
      .update({ left_at: input.date })
      .eq("collaborator_id", input.collaboratorId)
      .is("left_at", null)
      .neq("team_id", input.teamId);

    // 2) Ativa (ou cria) a pertença à equipa de destino.
    const { error: upErr } = await admin
      .from("team_members")
      .upsert(
        {
          team_id: input.teamId,
          collaborator_id: input.collaboratorId,
          left_at: null,
          joined_at: input.date,
        },
        { onConflict: "team_id,collaborator_id" },
      );
    if (upErr) return { ok: false, error: upErr.message };

    // 3) Limpa reatribuições diárias antigas desta colaboradora (agora obsoletas:
    //    a mudança passou a ser permanente).
    await admin
      .from("collaborator_ride_assignments")
      .delete()
      .eq("company_id", companyId)
      .eq("collaborator_id", input.collaboratorId);

    const isReset = false;
    const notified = await notifyDayTeam({
      admin,
      companyId,
      collaboratorId: input.collaboratorId,
      teamId: input.teamId,
      date: input.date,
      isReset,
    });

    return { ok: true, notified };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[moveCollaboratorToTeam] uncaught:", err);
    return { ok: false, error: msg };
  }
}

/** Avisa a colaboradora (in-app + web push) da equipa com que trabalha nesse dia. */
async function notifyDayTeam(args: {
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

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", collaboratorId)
    .eq("company_id", companyId);

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
