"use server";

import { createAdminClient } from "@/lib/supabase/admin";
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
  const admin = createAdminClient();

  const { error } = await admin.from("clients").insert({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
    company_id: input.company_id,
  });

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}

export async function updateCliente(id: string, input: Omit<ClienteInput, "company_id">) {
  const admin = createAdminClient();

  const { error } = await admin.from("clients").update({
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    nif: input.nif || null,
    status: input.status,
    vat_exempt: input.vat_exempt ?? false,
  }).eq("id", id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/clientes");
  return { ok: true as const };
}
