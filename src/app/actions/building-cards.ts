"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { BuildingCardWeekday } from "@/types/database";

export interface BuildingCard {
  id: string;
  company_id: string;
  weekday: BuildingCardWeekday;
  name: string;
  address: string | null;
  team_id: string | null;
  sort_order: number;
  monthly_value: number | null;
  notes: string | null;
}

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

async function requireManager(): Promise<{ companyId: string; userId: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Não autenticado");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    throw new Error("Sem permissão");
  }
  return { companyId: profile.company_id, userId: user.id };
}

export async function getBuildingCards(): Promise<BuildingCard[]> {
  const companyId = await getCompanyId();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("building_cards")
    .select("id, company_id, weekday, name, address, team_id, sort_order, monthly_value, notes")
    .eq("company_id", companyId)
    .order("weekday")
    .order("sort_order");

  if (error) throw error;
  return (data ?? []) as BuildingCard[];
}

export async function createBuildingCard(input: {
  weekday: BuildingCardWeekday;
  name: string;
  address?: string | null;
  teamId?: string | null;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const { companyId, userId } = await requireManager();
    const admin = createAdminClient();

    const { data: maxRow } = await admin
      .from("building_cards")
      .select("sort_order")
      .eq("company_id", companyId)
      .eq("weekday", input.weekday)
      .order("sort_order", { ascending: false })
      .limit(1);
    const sortOrder = (maxRow?.[0]?.sort_order ?? 0) + 1;

    const { data, error } = await admin
      .from("building_cards")
      .insert({
        company_id: companyId,
        weekday: input.weekday,
        name: input.name.trim(),
        address: input.address?.trim() || null,
        team_id: input.teamId || null,
        sort_order: sortOrder,
        notes: input.notes?.trim() || null,
        created_by: userId,
      })
      .select("id")
      .single();

    if (error) return { ok: false, error: error.message };
    revalidatePath("/dashboard/calendario");
    revalidatePath("/dashboard/clientes");
    return { ok: true, id: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[createBuildingCard] uncaught:", err);
    return { ok: false, error: msg };
  }
}

export async function updateBuildingCard(id: string, input: {
  name?: string;
  address?: string | null;
  teamId?: string | null;
  notes?: string | null;
  monthlyValue?: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { companyId } = await requireManager();
    const admin = createAdminClient();

    const patch: { name?: string; address?: string | null; team_id?: string | null; notes?: string | null; monthly_value?: number | null } = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.address !== undefined) patch.address = input.address?.trim() || null;
    if (input.teamId !== undefined) patch.team_id = input.teamId || null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.monthlyValue !== undefined) patch.monthly_value = input.monthlyValue;

    const { error } = await admin
      .from("building_cards")
      .update(patch)
      .eq("id", id)
      .eq("company_id", companyId);

    if (error) return { ok: false, error: error.message };
    revalidatePath("/dashboard/calendario");
    revalidatePath("/dashboard/clientes");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[updateBuildingCard] uncaught:", err);
    return { ok: false, error: msg };
  }
}

export async function deleteBuildingCard(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { companyId } = await requireManager();
    const admin = createAdminClient();

    const { error } = await admin
      .from("building_cards")
      .delete()
      .eq("id", id)
      .eq("company_id", companyId);

    if (error) return { ok: false, error: error.message };
    revalidatePath("/dashboard/calendario");
    revalidatePath("/dashboard/clientes");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[deleteBuildingCard] uncaught:", err);
    return { ok: false, error: msg };
  }
}

export async function reorderBuildingCards(
  weekday: BuildingCardWeekday,
  orderedIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { companyId } = await requireManager();
    const admin = createAdminClient();

    const { data: existing, error: fetchError } = await admin
      .from("building_cards")
      .select("id")
      .eq("company_id", companyId)
      .eq("weekday", weekday);
    if (fetchError) return { ok: false, error: fetchError.message };

    const validIds = new Set((existing ?? []).map((r) => r.id));
    if (orderedIds.some((id) => !validIds.has(id))) {
      return { ok: false, error: "Card inválido para este dia." };
    }

    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await admin
        .from("building_cards")
        .update({ sort_order: i })
        .eq("id", orderedIds[i])
        .eq("company_id", companyId);
      if (error) return { ok: false, error: error.message };
    }

    revalidatePath("/dashboard/calendario");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[reorderBuildingCards] uncaught:", err);
    return { ok: false, error: msg };
  }
}
