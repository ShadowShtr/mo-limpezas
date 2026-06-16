"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface ClienteInput {
  name: string;
  email?: string;
  phone?: string;
  nif?: string;
  status: string;
  vat_exempt?: boolean;
  company_id: string;
}

export async function createCliente(input: ClienteInput) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== input.company_id) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { error } = await admin.from("clients").insert({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
    company_id: profile.company_id,
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

export async function updateCliente(id: string, input: Omit<ClienteInput, "company_id">) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false as const, error: "Sem permissao." };
  }

  const { error } = await admin.from("clients").update({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
  }).eq("id", id).eq("company_id", profile.company_id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}
