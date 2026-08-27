"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { logQueryFailure } from "@/lib/query-error";
import {
  canonicalSnapshot,
  type DayAssignment,
  type TeamAllocationSnapshot,
  type VehicleAssignment,
} from "@/domain/teams/allocation-draft";

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
  team_id: string | null;
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

type RpcInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

export async function saveTeamDayAllocations(input: {
  date: string;
  expected: TeamAllocationSnapshot;
  memberAssignments: DayAssignment[];
  vehicleAllocations: VehicleAssignment[];
}): Promise<
  | { ok: true; snapshot: TeamAllocationSnapshot }
  | { ok: false; error: string; conflict?: boolean }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const admin = createAdminClient();
  const { data: actor, error: actorError } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (actorError || !actor || !["admin", "gestor"].includes(actor.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  const rpc = admin.rpc.bind(admin) as unknown as RpcInvoker;
  const { data, error } = await rpc("save_team_day_allocations", {
    p_company_id: actor.company_id,
    p_actor_id: user.id,
    p_date: input.date,
    p_expected_snapshot: canonicalSnapshot(input.expected),
    p_member_assignments: canonicalSnapshot({
      member_assignments: input.memberAssignments,
      vehicle_allocations: [],
    }).member_assignments,
    p_vehicle_allocations: canonicalSnapshot({
      member_assignments: [],
      vehicle_allocations: input.vehicleAllocations,
    }).vehicle_allocations,
  });

  if (error) {
    const conflict = error.message?.includes("TEAM_ALLOCATION_CONFLICT") ?? false;
    return {
      ok: false,
      conflict,
      error: conflict
        ? "As alocações foram alteradas por outra pessoa. Atualize antes de guardar novamente."
        : "Não foi possível guardar as alocações.",
    };
  }

  const snapshot = data as TeamAllocationSnapshot | null;
  if (!snapshot?.member_assignments || !snapshot?.vehicle_allocations) {
    return { ok: false, error: "A base devolveu uma resposta incompleta." };
  }

  const previous = new Map(input.expected.member_assignments.map((row) => [row.collaborator_id, row.team_id]));
  await Promise.all(snapshot.member_assignments
    .filter((row) => previous.get(row.collaborator_id) !== row.team_id)
    .map((row) => notifyDayTeam({
      admin,
      companyId: actor.company_id,
      collaboratorId: row.collaborator_id,
      teamId: row.team_id,
      date: input.date,
    })));

  revalidatePath("/dashboard/calendario");
  revalidatePath("/dashboard/equipas");
  revalidatePath("/app");
  return { ok: true, snapshot: canonicalSnapshot(snapshot) };
}

/** Avisa a colaboradora (in-app + web push) da equipa com que trabalha nesse dia. */
async function notifyDayTeam(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any;
  companyId: string;
  collaboratorId: string;
  teamId: string | null;
  date: string;
}): Promise<boolean> {
  const { admin, companyId, collaboratorId, teamId, date } = args;

  const [{ data: team }, { data: alloc }] = teamId ? await Promise.all([
    admin.from("teams").select("name").eq("id", teamId).single(),
    admin
      .from("vehicle_allocations")
      .select("vehicles(model, plate)")
      .eq("company_id", companyId)
      .eq("team_id", teamId)
      .eq("date", date)
      .maybeSingle(),
  ]) : [{ data: null }, { data: null }];

  const vehicle = alloc?.vehicles
    ? (Array.isArray(alloc.vehicles) ? alloc.vehicles[0] : alloc.vehicles)
    : null;
  const vehicleLabel = vehicle ? `${vehicle.model} (${vehicle.plate})` : null;
  const teamName = team?.name ?? "outra equipa";

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("pt-PT", {
    day: "2-digit", month: "2-digit",
  });

  const title = "🔄 Mudança de equipa";
  const body = teamId
    ? `${dateLabel}: trabalhas com a equipa ${teamName}${vehicleLabel ? ` (viatura ${vehicleLabel})` : ""}.`
    : `${dateLabel}: ficas disponível, sem equipa atribuída.`;

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
