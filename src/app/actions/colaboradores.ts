"use server";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import { isNoRowsError, logQueryFailure, queryFailure } from "@/lib/query-error";
import { getCurrentProfile, getCurrentUser } from "@/lib/auth/current-user";
import {
  normalizarColaborador,
  type ColaboradorInput,
} from "@/domain/collaborators/profile-input";

export async function createColaborador(input: ColaboradorInput) {
  const parsed = normalizarColaborador(input);
  if (!parsed.ok) return { ok: false as const, error: parsed.error };

  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const callerProfile = await getCurrentProfile();
  if (!callerProfile?.company_id) {
    return { ok: false as const, error: "COMPANY_CONTEXT_MISSING" };
  }
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (callerProfile.role === "gestor" && parsed.data.role !== "colaborador") {
    return { ok: false as const, error: "Sem permissão para atribuir essa função." };
  }

  const admin = createAdminClient();
  const id = randomUUID();
  const { error: profileError } = await admin
    .from("profiles")
    .insert({ id, company_id: callerProfile.company_id, ...parsed.data });

  if (profileError) return { ok: false as const, error: profileError.message };

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const, id };
}

export async function updateColaborador(
  id: string,
  input: ColaboradorInput,
) {
  const parsed = normalizarColaborador(input);
  if (!parsed.ok) return { ok: false as const, error: parsed.error };

  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const callerProfile = await getCurrentProfile();
  if (!callerProfile?.company_id) {
    return { ok: false as const, error: "COMPANY_CONTEXT_MISSING" };
  }
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (callerProfile.role === "gestor" && parsed.data.role !== "colaborador") {
    return { ok: false as const, error: "Sem permissão para atribuir essa função." };
  }

  const admin = createAdminClient();

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
    .update(parsed.data)
    .eq("id", id)
    .eq("company_id", callerProfile.company_id);

  if (error) return { ok: false as const, error: error.message };

  // Auditoria dos campos sensíveis (privilégio/dados bancários) — sem isto
  // uma escalada de privilégio (role) ou alteração de IBAN não deixa rasto.
  const after = {
    role: parsed.data.role,
    iban: parsed.data.iban,
    hourly_rate: parsed.data.hourly_rate,
    nif: parsed.data.nif,
  };
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
    .eq("auth_user_id", user.id)
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
    .eq("auth_user_id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("company_id, full_name, auth_user_id")
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
  if (!target.auth_user_id) {
    return { ok: false as const, error: "Esta colaboradora ainda não tem conta de acesso." };
  }

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let rnd = "";
  for (const b of crypto.getRandomValues(new Uint8Array(10))) rnd += chars[b % chars.length];
  const password = "Mo" + rnd + "!9";

  const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
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
    .eq("auth_user_id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("company_id, full_name, auth_user_id")
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
  if (!target.auth_user_id) {
    return { ok: false as const, error: "Esta colaboradora ainda não tem conta de acesso." };
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

export async function deleteColaborador(id: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };
  const { data: caller } = await admin
    .from("profiles").select("id, company_id, role").eq("auth_user_id", user.id).single();
  if (!caller || !["admin", "gestor"].includes(caller.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (caller.id === id) return { ok: false as const, error: "Não podes excluir a tua própria conta." };

  const { data: target, error: targetError } = await admin
    .from("profiles").select("id, company_id, full_name, auth_user_id").eq("id", id).single();
  // Decide QUEM é eliminado, e a verificação de empresa depende disto.
  if (targetError && !isNoRowsError(targetError)) {
    return queryFailure("deleteColaborador:target", targetError);
  }
  if (!target || target.company_id !== caller.company_id) {
    return { ok: false as const, error: "Colaboradora inválida." };
  }

  const companyId = caller.company_id;

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

  // O perfil deixou de depender de Auth: elimina-o explicitamente e só tenta
  // remover a conta de acesso quando ela existe.
  const { error: profileDeleteError } = await admin
    .from("profiles")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);
  if (profileDeleteError) return { ok: false as const, error: profileDeleteError.message };

  if (target.auth_user_id) {
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(target.auth_user_id);
    if (authDeleteError) {
      return { ok: false as const, error: "Perfil eliminado, mas a conta de acesso exige remoção manual." };
    }
  }

  revalidatePath("/dashboard/colaboradores");
  revalidatePath("/dashboard/equipas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const };
}
