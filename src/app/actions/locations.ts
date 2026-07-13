"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";

interface LocationInput {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  pricing_type: "hourly" | "fixed";
  hourly_rate: number | null;
  fixed_price: number | null;
  access_code: string | null;
  has_key: boolean;
  key_label: string | null;
  instructions: string | null;
  active: boolean;
  client_id: string;
  company_id: string;
}

export async function createLocation(input: LocationInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) {
    return { ok: false as const, error: "Sem permissão para criar locais." };
  }

  const { error } = await admin.from("locations").insert({
    name: input.name,
    address: input.address,
    lat: input.lat,
    lng: input.lng,
    pricing_type: input.pricing_type,
    hourly_rate: input.hourly_rate,
    fixed_price: input.fixed_price,
    access_code: input.access_code,
    has_key: input.has_key,
    key_label: input.key_label,
    instructions: input.instructions,
    active: input.active,
    client_id: input.client_id,
    company_id: me.company_id,
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/locais");
  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

export async function updateLocation(id: string, input: Omit<LocationInput, "client_id" | "company_id">) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) {
    return { ok: false as const, error: "Sem permissão para editar locais." };
  }

  // Valor antigo dos campos de preço/acesso, só para auditoria — nunca
  // bloqueia o update se falhar.
  const { data: before } = await admin
    .from("locations")
    .select("pricing_type, hourly_rate, fixed_price, access_code, has_key, key_label")
    .eq("id", id)
    .eq("company_id", me.company_id)
    .single();

  const { error } = await admin
    .from("locations")
    .update({
      name: input.name,
      address: input.address,
      lat: input.lat,
      lng: input.lng,
      pricing_type: input.pricing_type,
      hourly_rate: input.hourly_rate,
      fixed_price: input.fixed_price,
      access_code: input.access_code,
      has_key: input.has_key,
      key_label: input.key_label,
      instructions: input.instructions,
      active: input.active,
    })
    .eq("id", id)
    .eq("company_id", me.company_id);

  if (error) return { ok: false as const, error: error.message };

  // Auditoria de preço/acesso físico — sem isto uma alteração acidental de
  // hourly_rate/fixed_price ou de código de acesso/chave não deixa rasto.
  const after = {
    pricing_type: input.pricing_type, hourly_rate: input.hourly_rate, fixed_price: input.fixed_price,
    access_code: input.access_code, has_key: input.has_key, key_label: input.key_label,
  };
  if (
    before &&
    (before.pricing_type !== after.pricing_type || before.hourly_rate !== after.hourly_rate ||
      before.fixed_price !== after.fixed_price || before.access_code !== after.access_code ||
      before.has_key !== after.has_key || before.key_label !== after.key_label)
  ) {
    await auditLog({
      companyId: me.company_id,
      actorId: user.id,
      action: "local_preco_acesso_alterado",
      entityType: "location",
      entityId: id,
      before,
      after,
      source: "dashboard",
    }, admin);
  }

  revalidatePath("/dashboard/locais");
  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

/** Atualiza apenas os campos de acesso do local (chave/código/instruções).
 *  Usado para editar diretamente a partir do calendário, sem mexer no resto. */
export async function updateLocationAccess(
  id: string,
  input: { has_key: boolean; key_label: string | null; access_code: string | null; instructions: string | null },
) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) {
    return { ok: false as const, error: "Sem permissão para editar locais." };
  }

  const { error } = await admin
    .from("locations")
    .update({
      has_key: input.has_key,
      key_label: input.has_key ? (input.key_label?.trim() || null) : null,
      access_code: input.access_code?.trim() || null,
      instructions: input.instructions?.trim() || null,
    })
    .eq("id", id)
    .eq("company_id", me.company_id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/locais");
  revalidatePath("/dashboard/clientes");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}

export async function deleteLocation(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me || !["admin", "gestor"].includes(me.role)) {
    return { ok: false as const, error: "Sem permissão para eliminar locais." };
  }

  const { error } = await admin
    .from("locations")
    .delete()
    .eq("id", id)
    .eq("company_id", me.company_id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/locais");
  return { ok: true as const };
}
