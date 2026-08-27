"use server";

/**
 * Dar, tirar e devolver acesso a uma pessoa que já existe.
 *
 * 🔴 Tudo aqui corre **no servidor**, com a chave de administração. Nenhuma
 *    destas operações tem equivalente do lado do cliente, e a chave nunca sai
 *    daqui — expô-la ao browser daria a qualquer pessoa autenticada o poder de
 *    criar contas e redefinir senhas.
 *
 * A autorização é decidida contra a empresa de quem está autenticado, lida da
 * base, e **nunca** contra um valor vindo do pedido. A interface não é
 * autoridade sobre nada disto.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import {
  podeCriarAcesso, exigeAcessoExistente, identificadorDeAutenticacao,
  validarSenhaTemporaria, compensacaoNecessaria,
  type Actor, type Pessoa,
} from "@/domain/collaborators/access-lifecycle";

type Resultado = { ok: true } | { ok: false; error: string };

/** Quem está a pedir, e de que empresa — lido da base, não do pedido. */
async function resolverActor(): Promise<Actor | null> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await admin
    .from("profiles")
    .select("id, company_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!data) return null;
  return { profile_id: data.id, company_id: data.company_id, role: data.role };
}

/** A pessoa sobre quem se está a operar. */
async function carregarPessoa(id: string): Promise<Pessoa | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, company_id, full_name, auth_user_id")
    .eq("id", id)
    .maybeSingle();
  return (data as Pessoa) ?? null;
}

/**
 * Criar acesso para quem ainda não tem.
 *
 * 🔴 A ordem e a compensação são o essencial desta função.
 *
 *    Criar a conta e gravar a ligação são escritas em sistemas diferentes, sem
 *    transação comum. Se a conta nascer e a ligação falhar, fica uma
 *    identidade capaz de autenticar que não pertence a ninguém — e a próxima
 *    tentativa encontraria o identificador ocupado, sem saber de quem. Por
 *    isso: cria-se, liga-se, e **desfaz-se a conta** se a ligação não gravar.
 *
 *    A gravação é condicional a `auth_user_id` continuar nulo. Dois
 *    administradores a carregar ao mesmo tempo: um grava, o outro afecta zero
 *    linhas e compensa. Uma conta, uma ligação.
 */
export async function criarAcesso(
  profileId: string, senhaTemporaria: string,
): Promise<Resultado> {
  const actor = await resolverActor();
  if (!actor) return { ok: false, error: "Não autenticado." };

  const pessoa = await carregarPessoa(profileId);
  if (!pessoa) return { ok: false, error: "Pessoa não encontrada." };

  const permissao = podeCriarAcesso(actor, pessoa);
  if (!permissao.permitido) return { ok: false, error: permissao.motivo };

  const senha = validarSenhaTemporaria(senhaTemporaria);
  if (!senha.ok) return { ok: false, error: senha.erro };

  const admin = createAdminClient();

  const { data: criada, error: erroConta } = await admin.auth.admin.createUser({
    email: identificadorDeAutenticacao(pessoa.id),
    password: senhaTemporaria,
    email_confirm: true,
  });
  if (erroConta || !criada?.user) {
    // A pessoa fica exactamente como estava. Não se apaga ninguém porque o
    // Auth não respondeu.
    return { ok: false, error: erroConta?.message ?? "Não foi possível criar o acesso." };
  }

  const { data: ligadas, error: erroLigacao } = await admin
    .from("profiles")
    .update({ auth_user_id: criada.user.id, must_change_password: true })
    .eq("id", pessoa.id)
    .is("auth_user_id", null)
    .select("id");

  const ligou = !erroLigacao && (ligadas?.length ?? 0) === 1;

  if (compensacaoNecessaria(true, ligou) === "apagar_conta") {
    // Best-effort, e deliberado: se isto também falhar, o erro devolvido diz
    // que houve uma conta que ficou por limpar — é informação que quem
    // administra precisa de ter, não algo a esconder.
    const { error: erroApagar } = await admin.auth.admin.deleteUser(criada.user.id);
    if (erroApagar) {
      return {
        ok: false,
        error: "O acesso não ficou ligado a esta pessoa e a conta criada não " +
          "pôde ser removida. Contacte quem administra o sistema antes de " +
          "tentar outra vez.",
      };
    }
    return {
      ok: false,
      error: erroLigacao?.message ?? "Esta pessoa já tinha acesso — nada foi alterado.",
    };
  }

  // 🔴 A senha não vai para o registo. Fica quem, a quem, e quando.
  await auditLog({
    companyId: actor.company_id,
    actorId: actor.profile_id,
    action: "access_created",
    entityType: "profile",
    entityId: pessoa.id,
  });

  revalidatePath(`/dashboard/colaboradores/${pessoa.id}`);
  return { ok: true };
}

/**
 * Definir uma senha temporária nova para quem já tem acesso.
 *
 * Não existe forma de ler a senha actual — nem aqui, nem em lado nenhum. O
 * administrador define uma nova e comunica-a; a pessoa é obrigada a trocá-la.
 */
export async function definirSenhaTemporaria(
  profileId: string, senhaTemporaria: string,
): Promise<Resultado> {
  const actor = await resolverActor();
  if (!actor) return { ok: false, error: "Não autenticado." };

  const pessoa = await carregarPessoa(profileId);
  if (!pessoa) return { ok: false, error: "Pessoa não encontrada." };

  const permissao = exigeAcessoExistente(actor, pessoa, "definir senha");
  if (!permissao.permitido) return { ok: false, error: permissao.motivo };

  const senha = validarSenhaTemporaria(senhaTemporaria);
  if (!senha.ok) return { ok: false, error: senha.erro };

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(
    pessoa.auth_user_id as string, { password: senhaTemporaria });
  if (error) return { ok: false, error: error.message };

  const { error: erroMarca } = await admin
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", pessoa.id);
  if (erroMarca) {
    // A senha já mudou; não marcar a troca obrigatória é menos grave do que
    // deixar a pessoa sem saber que a senha mudou, mas não se cala.
    return {
      ok: false,
      error: "A senha foi alterada, mas não ficou marcada a obrigação de a " +
        "trocar no primeiro acesso. Repita a operação.",
    };
  }

  await auditLog({
    companyId: actor.company_id,
    actorId: actor.profile_id,
    action: "temp_password_set",
    entityType: "profile",
    entityId: pessoa.id,
  });

  revalidatePath(`/dashboard/colaboradores/${pessoa.id}`);
  return { ok: true };
}

/**
 * Desactivar o acesso.
 *
 * 🔴 Isto não apaga a pessoa, nem a folha, nem os documentos, nem o histórico.
 *    Impede-a de entrar, e mais nada. A conta continua a ser dela — reactivar
 *    devolve-lhe a mesma, não cria outra.
 */
export async function desativarAcesso(profileId: string): Promise<Resultado> {
  const actor = await resolverActor();
  if (!actor) return { ok: false, error: "Não autenticado." };

  const pessoa = await carregarPessoa(profileId);
  if (!pessoa) return { ok: false, error: "Pessoa não encontrada." };

  const permissao = exigeAcessoExistente(actor, pessoa, "desactivar");
  if (!permissao.permitido) return { ok: false, error: permissao.motivo };

  const admin = createAdminClient();
  // Um banimento longo é a forma de o Supabase representar «não entra», e
  // preserva a conta — que é precisamente o que se quer.
  const { error } = await admin.auth.admin.updateUserById(
    pessoa.auth_user_id as string, { ban_duration: "876000h" });
  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId: actor.company_id,
    actorId: actor.profile_id,
    action: "access_disabled",
    entityType: "profile",
    entityId: pessoa.id,
  });

  revalidatePath(`/dashboard/colaboradores/${pessoa.id}`);
  return { ok: true };
}

/** Devolver o acesso — a mesma conta, não uma nova. */
export async function reativarAcesso(profileId: string): Promise<Resultado> {
  const actor = await resolverActor();
  if (!actor) return { ok: false, error: "Não autenticado." };

  const pessoa = await carregarPessoa(profileId);
  if (!pessoa) return { ok: false, error: "Pessoa não encontrada." };

  const permissao = exigeAcessoExistente(actor, pessoa, "reactivar");
  if (!permissao.permitido) return { ok: false, error: permissao.motivo };

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(
    pessoa.auth_user_id as string, { ban_duration: "none" });
  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId: actor.company_id,
    actorId: actor.profile_id,
    action: "access_reenabled",
    entityType: "profile",
    entityId: pessoa.id,
  });

  revalidatePath(`/dashboard/colaboradores/${pessoa.id}`);
  return { ok: true };
}
