"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface ColaboradorInput {
  full_name: string;
  email?: string;
  phone?: string;
  nif?: string;
  iban?: string;
  hourly_rate?: number | null;
  contract_start?: string | null;
  contract_end?: string | null;
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

  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (callerProfile.company_id !== parsed.data.company_id) {
    return { ok: false as const, error: "Acesso negado." };
  }

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
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }

  const { error } = await admin
    .from("profiles")
    .update({
      full_name: input.full_name,
      email: input.email?.trim() || null,
      phone: input.phone || null,
      nif: input.nif || null,
      iban: input.iban || null,
      hourly_rate: input.hourly_rate ?? null,
      contract_start: input.contract_start || null,
      contract_end: input.contract_end || null,
      role: input.role,
      status: input.status,
      contracted_hours_month: input.contracted_hours_month,
      skills: input.skills,
    })
    .eq("id", id)
    .eq("company_id", callerProfile.company_id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const };
}

// Redefine a password de uma colaboradora gerando uma nova provisória.
// Sem email/domínio: o admin/gestor recebe a senha no ecrã para a entregar.
export async function resetColaboradorPassword(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }

  const { data: target } = await admin
    .from("profiles")
    .select("company_id, full_name")
    .eq("id", id)
    .single();
  if (!target) return { ok: false as const, error: "Colaboradora não encontrada." };
  if (target.company_id !== callerProfile.company_id) {
    return { ok: false as const, error: "Acesso negado." };
  }

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let rnd = "";
  for (const b of crypto.getRandomValues(new Uint8Array(10))) rnd += chars[b % chars.length];
  const password = "Mo" + rnd + "!9";

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { ok: false as const, error: "Não foi possível redefinir a password." };

  return { ok: true as const, password, name: target.full_name as string };
}

export async function deleteColaborador(id: string, companyId: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };
  if (user.id === id) return { ok: false as const, error: "Não podes excluir a tua própria conta." };

  const { data: caller } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!caller || !["admin", "gestor"].includes(caller.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (caller.company_id !== companyId) return { ok: false as const, error: "Empresa inválida." };

  const { data: target } = await admin
    .from("profiles").select("id, company_id, full_name").eq("id", id).single();
  if (!target || target.company_id !== companyId) {
    return { ok: false as const, error: "Colaboradora inválida." };
  }

  // Anula referências RESTRICT a este perfil (senão o cascade do auth bloqueia).
  // Preserva os registos (serviços, contratos, faturas, etc.), só remove a autoria.
  await admin.from("services").update({ created_by: null }).eq("company_id", companyId).eq("created_by", id);
  await admin.from("services").update({ cancelled_by: null }).eq("company_id", companyId).eq("cancelled_by", id);
  await admin.from("contracts").update({ created_by: null }).eq("company_id", companyId).eq("created_by", id);
  await admin.from("absences").update({ created_by: null }).eq("company_id", companyId).eq("created_by", id);
  await admin.from("absences").update({ approved_by: null }).eq("company_id", companyId).eq("approved_by", id);
  await admin.from("absences").update({ replaced_by: null }).eq("company_id", companyId).eq("replaced_by", id);
  await admin.from("vacation_requests").update({ reviewed_by: null }).eq("company_id", companyId).eq("reviewed_by", id);
  await admin.from("invoices").update({ created_by: null }).eq("company_id", companyId).eq("created_by", id);
  await admin.from("payroll_records").update({ approved_by: null }).eq("company_id", companyId).eq("approved_by", id);

  // Apaga o utilizador auth → cascade do profile (team_members, timesheets,
  // ausências, férias, folha, reforços, notificações).
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/dashboard/colaboradores");
  revalidatePath("/dashboard/equipas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}
