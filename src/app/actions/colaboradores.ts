"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

export interface ColaboradorInput {
  full_name: string;
  email?: string;
  phone?: string;
  role: string;
  status: string;
  contracted_hours_month: number;
  skills: string[];
  company_id: string;
}

const colaboradorSchema = z.object({
  full_name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres.").max(120).trim(),
  email: z.email("Email inválido.").optional().or(z.literal("")),
  phone: z.string().max(20).optional(),
  role: z.enum(["colaborador", "gestor", "admin"]),
  status: z.enum(["ativo", "inativo", "arquivado"]),
  contracted_hours_month: z.number().min(0).max(744),
  skills: z.array(z.string().max(60)),
  company_id: z.string().uuid("company_id inválido."),
});

export async function createColaborador(input: ColaboradorInput) {
  const parsed = colaboradorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0].message };
  }

  const admin = createAdminClient();

  // Gera email placeholder se não fornecido (formato válido obrigatório pelo GoTrue)
  const email =
    parsed.data.email?.trim() ||
    `${input.full_name.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "")}.${Date.now()}@demo.escala.pt`;

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      company_id: parsed.data.company_id,
      role: parsed.data.role,
      full_name: parsed.data.full_name,
    },
  });

  if (authError) return { ok: false as const, error: authError.message };

  // Upsert do profile — cobre o caso em que o trigger falhou silenciosamente
  const { error: profileError } = await admin
    .from("profiles")
    .upsert({
      id: authData.user.id,
      company_id: parsed.data.company_id,
      role: parsed.data.role,
      full_name: parsed.data.full_name,
      email: parsed.data.email?.trim() || null,
      phone: parsed.data.phone || null,
      status: parsed.data.status,
      contracted_hours_month: parsed.data.contracted_hours_month,
      skills: parsed.data.skills,
    }, { onConflict: "id" });

  if (profileError) return { ok: false as const, error: profileError.message };

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const };
}

export async function updateColaborador(
  id: string,
  input: Omit<ColaboradorInput, "company_id">,
) {
  const admin = createAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({
      full_name: input.full_name,
      email: input.email?.trim() || null,
      phone: input.phone || null,
      role: input.role,
      status: input.status,
      contracted_hours_month: input.contracted_hours_month,
      skills: input.skills,
    })
    .eq("id", id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const };
}
