"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { validarValorMonetario } from "@/domain/finance-v2/money";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { BuildingCardWeekday } from "@/types/database";
import { queryFailure } from "@/lib/query-error";

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

/**
 * Valida a avença mensal, **no servidor**.
 *
 * 🔴 A validação do formulário não conta. Uma server action é um endpoint: um
 *    pedido feito à mão, um cliente antigo em cache ou um script chegam cá sem
 *    passar pelo `<input>`. E este número alimenta o card financeiro do
 *    Resumo — `NaN` propaga-se por qualquer soma que o toque, e um valor
 *    negativo apareceria como uma avença que a empresa paga ao cliente.
 *
 * A regra vive em `@/domain/finance-v2/money`, importável e testada a
 * executar. A primeira versão estava aqui dentro, num ficheiro `"use server"`
 * que não se pode importar — e por isso só era "testada" por inspecção do
 * texto. O teste confirmava que a linha existia; não que ela funcionava. E não
 * funcionava: recusava 0,29 €, 10,12 € e 19,99 €.
 */
function validarAvenca(valor: number | null | undefined) {
  return validarValorMonetario(valor, { nome: "A avença mensal" });
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
  /**
   * A avença mensal.
   *
   * 🔴 Faltava aqui. O card «Prédios» do Resumo mostra este valor, e os 146
   *    prédios importados têm-no todos a `null` — mas não havia forma de o
   *    preencher: `createBuildingCard` não o aceitava e o formulário não o
   *    tinha. Um número que só se pode ler nunca deixa de ser desconhecido.
   *
   *    `undefined` e `null` significam o mesmo aqui: valor por preencher. Não
   *    se converte para zero, que diria que o prédio não rende nada.
   */
  monthlyValue?: number | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const { companyId, userId } = await requireManager();
    const admin = createAdminClient();

    const avenca = validarAvenca(input.monthlyValue);
    if (!avenca.ok) return { ok: false, error: avenca.error };

    // Próxima posição na coluna. Falhando a leitura, `sort_order` recomeçava
    // em 1 e o cartão novo aterrava no meio da ordem já existente — sem erro
    // nenhum, só a coluna desarrumada.
    const { data: maxRow, error: maxRowError } = await admin
      .from("building_cards")
      .select("sort_order")
      .eq("company_id", companyId)
      .eq("weekday", input.weekday)
      .order("sort_order", { ascending: false })
      .limit(1);
    if (maxRowError) return queryFailure("createBuildingCard:sort_order", maxRowError);
    const sortOrder = (maxRow?.[0]?.sort_order ?? 0) + 1;

    const { data, error } = await admin
      .from("building_cards")
      .insert({
        company_id: companyId,
        weekday: input.weekday,
        name: input.name.trim(),
        address: input.address?.trim() || null,
        monthly_value: avenca.valor,
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
    // O card «Prédios» do Resumo lê `building_cards` — sem isto, mudar uma
    // avença não mexia no número que o dono estava a ver.
    revalidatePath("/dashboard/financeiro");
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

    if (input.monthlyValue !== undefined) {
      const avenca = validarAvenca(input.monthlyValue);
      if (!avenca.ok) return { ok: false, error: avenca.error };
    }

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
    // O card «Prédios» do Resumo lê `building_cards` — sem isto, mudar uma
    // avença não mexia no número que o dono estava a ver.
    revalidatePath("/dashboard/financeiro");
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
    // O card «Prédios» do Resumo lê `building_cards` — sem isto, mudar uma
    // avença não mexia no número que o dono estava a ver.
    revalidatePath("/dashboard/financeiro");
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
