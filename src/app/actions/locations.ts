"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

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

  revalidatePath("/dashboard/locais");
  revalidatePath("/dashboard/clientes");
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
