"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import { isNoRowsError, logQueryFailure, queryFailure } from "@/lib/query-error";

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
}

/**
 * 🔴 Só o nome é obrigatório.
 *
 * Tudo o resto pode ficar por preencher e ser completado mais tarde no perfil.
 * Uma pessoa entra na empresa antes de alguém ter o NIF, o IBAN ou a data de
 * contrato à mão, e obrigar a inventá-los para poder guardar é como se
 * perdiam: um valor inventado é indistinguível de um verdadeiro para quem o
 * ler a seguir.
 *
 * `role`, `status` e `contracted_hours_month` têm omissão em vez de serem
 * exigidos — uma pessoa nova é uma colaboradora activa até alguém decidir
 * outra coisa.
 *
 * 🔴 `company_id` **não está aqui, e não pode voltar.**
 *
 *    Estava — declarado como `z.string().uuid()`, aceite pela forma e depois
 *    ignorado, porque a empresa vem sempre da sessão de quem cria. Peso morto,
 *    até deixar de ser: o Zod 4 passou a validar UUIDs contra a RFC 9562, que
 *    exige um nibble de versão entre 1 e 8. O `company_id` desta empresa é
 *    `00000000-0000-0000-0000-000000000001`, com versão `0`.
 *
 *    Resultado: **criar um colaborador ficou impossível** — «company_id
 *    inválido.» — por causa de um campo que o servidor nem lê. O Zod 3 aceitava,
 *    o Zod 4 não, e a falha apareceu numa atualização de dependência, longe de
 *    qualquer alteração a colaboradores.
 *
 *    A lição não é «relaxar a validação». É que validar o que não se usa só
 *    pode fazer mal: não protege nada e cria uma forma de falhar. A empresa
 *    resolve-se no servidor, a partir do perfil de quem está autenticado, e é
 *    lá que tem de ser verificada.
 */
const colaboradorSchema = z.object({
  full_name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres.").max(120).trim(),
  email: z.email("Email inválido.").optional().or(z.literal("")),
  phone: z.string().max(20).optional(),
  role: z.enum(["colaborador", "gestor", "admin"]).default("colaborador"),
  status: z.enum(["ativo", "inativo", "arquivado"]).default("ativo"),
  contracted_hours_month: z.number().min(0).max(744).nullable().optional(),
  skills: z.array(z.string().max(60)).default([]),
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
  // company_id vem sempre da sessão do chamador, nunca do payload do
  // cliente — o valor recebido em `input.company_id` é ignorado a partir
  // daqui (só serviu para passar na validação de forma do schema).
  const companyId = callerProfile.company_id;

  // 🔴 Criar uma pessoa não cria conta de acesso, e não inventa dados.
  //
  //    O código anterior fazia as duas coisas: chamava `auth.admin.createUser`
  //    sempre, e quando não havia email fabricava um
  //    (`nome.1724713200000@demo.escala.pt`) porque o GoTrue exige um. Esse
  //    endereço ficava guardado como se fosse o email da pessoa.
  //
  //    Agora: `INSERT` em `profiles` e mais nada. Quem precisar de entrar na
  //    aplicação recebe acesso depois, no perfil, por uma acção própria — e é
  //    aí que uma conta é criada, com um identificador de autenticação que
  //    ninguém confunde com o email pessoal.
  //
  //    `COLLABORATOR_CREATE_AUTH_WRITE = 0`.
  //
  //    Isto só é possível porque `profiles.id` deixou de ser chave estrangeira
  //    para `auth.users` (ver o EXPAND). Antes disso não havia id para dar a
  //    uma pessoa sem conta.
  const { error: profileError } = await admin
    .from("profiles")
    .insert({
      company_id: companyId,
      role: parsed.data.role,
      full_name: parsed.data.full_name,
      email: parsed.data.email?.trim() || null,
      phone: parsed.data.phone || null,
      status: parsed.data.status,
      contracted_hours_month: parsed.data.contracted_hours_month,
      skills: parsed.data.skills,
    });

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

  // Valor antigo dos campos sensíveis (privilégio, dados bancários), só para
  // auditoria — nunca bloqueia o update se falhar.
  const { data: before, error: beforeError } = await admin
    .from("profiles")
    .select("role, iban, hourly_rate, nif")
    .eq("id", id)
    .eq("company_id", callerProfile.company_id)
    .single();
  // Auxiliar: alimenta a auditoria do que mudou, não decide o update.
  if (!isNoRowsError(beforeError)) logQueryFailure("updateColaborador:before", beforeError);

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

  // Auditoria dos campos sensíveis (privilégio/dados bancários) — sem isto
  // uma escalada de privilégio (role) ou alteração de IBAN não deixa rasto.
  const after = { role: input.role, iban: input.iban || null, hourly_rate: input.hourly_rate ?? null, nif: input.nif || null };
  if (
    before &&
    (before.role !== after.role || before.iban !== after.iban ||
      before.hourly_rate !== after.hourly_rate || before.nif !== after.nif)
  ) {
    await auditLog({
      companyId: callerProfile.company_id,
      actorId: user.id,
      action: "colaborador_dados_sensiveis_alterados",
      entityType: "profile",
      entityId: id,
      before,
      after,
      source: "dashboard",
    }, admin);
  }

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const };
}

// Define o saldo de férias (dias) de uma colaboradora.
export async function updateVacationBalance(id: string, balance: number) {
  if (!Number.isFinite(balance) || balance < 0 || balance > 60) {
    return { ok: false as const, error: "Saldo inválido." };
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

  const { error } = await admin
    .from("profiles")
    .update({ vacation_balance: balance })
    .eq("id", id)
    .eq("company_id", callerProfile.company_id);

  if (error) return { ok: false as const, error: error.message };

  revalidatePath(`/dashboard/colaboradores/${id}`);
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

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("company_id, full_name")
    .eq("id", id)
    .single();
  // Decide sobre QUEM se repõe a password. Falhando, dizia "não encontrada".
  if (targetError && !isNoRowsError(targetError)) {
    return queryFailure("resetColaboradorPassword:target", targetError);
  }
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

/**
 * Manda um push de controlo à colaboradora a pedir para verificar/aplicar
 * já uma atualização pendente da app — para quando ela fica presa numa
 * versão antiga e nunca chega a fechar/reabrir a app (ver sendForceUpdatePush).
 * Não garante nada: depende de o telemóvel entregar o push com a app fechada.
 */
export async function forceAppUpdate(id: string) {
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

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("company_id, full_name")
    .eq("id", id)
    .single();
  // Decide a QUEM se envia o pedido de actualização forçada da app.
  if (targetError && !isNoRowsError(targetError)) {
    return queryFailure("forceAppUpdate:target", targetError);
  }
  if (!target) return { ok: false as const, error: "Colaboradora não encontrada." };
  if (target.company_id !== callerProfile.company_id) {
    return { ok: false as const, error: "Acesso negado." };
  }

  const { sendForceUpdatePush } = await import("@/lib/push-notify");
  const { sent } = await sendForceUpdatePush(admin, { companyId: callerProfile.company_id, userId: id });

  if (sent === 0) {
    return { ok: false as const, error: "Não foi possível enviar — a colaboradora pode não ter notificações ativas neste telemóvel." };
  }

  await auditLog({
    companyId: callerProfile.company_id,
    actorId: user.id,
    action: "force_app_update_sent",
    entityType: "profile",
    entityId: id,
    meta: { target_name: target.full_name },
    source: "dashboard",
  }, admin);

  return { ok: true as const, sent };
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

  const { data: target, error: targetError } = await admin
    .from("profiles").select("id, company_id, full_name").eq("id", id).single();
  // Decide QUEM é eliminado, e a verificação de empresa depende disto.
  if (targetError && !isNoRowsError(targetError)) {
    return queryFailure("deleteColaborador:target", targetError);
  }
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
