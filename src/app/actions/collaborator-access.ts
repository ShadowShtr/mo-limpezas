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
import { requireProfile } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import {
  podeCriarAcesso, exigeAcessoExistente, identificadorDeAutenticacao,
  validarSenhaTemporaria, compensacaoNecessaria,
  type Actor, type Pessoa,
} from "@/domain/collaborators/access-lifecycle";
import {
  ESTADO_AUTORIZADO, estadoAutoriza, isEstadoColaborador,
  type EstadoColaborador,
} from "@/domain/collaborators/status";

type Resultado = { ok: true } | { ok: false; error: string };

/**
 * Quem está a pedir, e de que empresa — lido da base, não do pedido.
 *
 * 🔴 ISTO ERA UMA TERCEIRA REGRA DE ACTOR, E ESCAPAVA A TUDO.
 *
 *    Fazia a sua própria consulta com `service_role` — que tem BYPASSRLS, e
 *    por isso ignora a migration 106 — por `profiles.id = user.id`, e não
 *    olhava para `status`. Uma admin ou gestora suspensa, com a sessão ainda
 *    válida, podia invocar directamente as quatro actions deste ficheiro:
 *    criar acesso a terceiros, definir senhas, desactivar e reactivar.
 *
 *    Escapava à 106 **e** ao `requireProfile()` corrigido, porque não passava
 *    por nenhum dos dois.
 *
 *    Agora passa pelo guard central. A verificação de estado acontece lá
 *    dentro, ANTES da de papel — quem não tem acesso nenhum não recebe «Sem
 *    permissão», que sugeriria que outro papel resolveria o problema.
 *
 *    O papel exigido está aqui e não no guard porque é desta operação: gerir
 *    o acesso de terceiros é de quem administra, e só.
 */
async function resolverActor(): Promise<Actor | null> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return null;
  return {
    profile_id: guard.profile.id,
    company_id: guard.profile.company_id,
    role: guard.profile.role,
  };
}

/** A pessoa sobre quem se está a operar. */
async function carregarPessoa(id: string): Promise<Pessoa | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, company_id, full_name, auth_user_id, status")
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
export async function desativarAcesso(
  profileId: string,
  novoEstado: EstadoColaborador = "inativo",
): Promise<Resultado> {
  // 🔴 O TIPO NAO E UMA PROMESSA. ISTO E UMA SERVER ACTION.
  //
  //    `EstadoColaborador` desaparece na compilacao. O que chega aqui vem do
  //    lado de la da rede e pode ser qualquer coisa — o browser nao e
  //    autoridade sobre nada.
  //
  //    O caso perigoso nao e um valor absurdo: e `"ativo"`. Sem esta guarda,
  //    `desativarAcesso(id, "ativo")` gravava `status = 'ativo'` e a seguir
  //    banava a conta no Auth. Resultado: a pessoa fica impedida de entrar de
  //    novo E a sessao que ja tem continua AUTORIZADA, porque desde a 106 e o
  //    estado que autoriza. Uma operacao chamada «desactivar» deixava o acesso
  //    aberto — e com ar de ter corrido bem.
  //
  //    Duas condicoes, e nao uma lista nova: o estado tem de ser reconhecido
  //    pela fonte unica, e tem de NAO autorizar. Escrito assim, um estado que
  //    a base venha a aceitar amanha so serve para desactivar se de facto
  //    tirar acesso.
  //
  //    Antes de qualquer escrita, das duas.
  if (!isEstadoColaborador(novoEstado) || estadoAutoriza(novoEstado)) {
    return {
      ok: false,
      error: "Estado inválido para retirar acesso.",
    };
  }

  const actor = await resolverActor();
  if (!actor) return { ok: false, error: "Não autenticado." };

  const pessoa = await carregarPessoa(profileId);
  if (!pessoa) return { ok: false, error: "Pessoa não encontrada." };

  const permissao = exigeAcessoExistente(actor, pessoa, "desactivar");
  if (!permissao.permitido) return { ok: false, error: permissao.motivo };

  const admin = createAdminClient();

  // 🔴 A ORDEM: PRIMEIRO O ESTADO, DEPOIS O BANIMENTO.
  //
  //    Esta função escrevia SÓ no Auth. `profiles.status` ficava em `ativo` e
  //    a pessoa continuava a autorizar em toda a base — o banimento impedia-a
  //    de fazer login NOVO, e mais nada. Com a sessão aberta, continuava a
  //    trabalhar. Eram duas verdades sobre a mesma pessoa, e a que a base
  //    consulta era a que ninguém escrevia.
  //
  //    Desde a migration 106, `profiles.status` é a fonte de autorização. Por
  //    isso escreve-se PRIMEIRO, e só depois se bane:
  //
  //      · se o estado gravar e o banimento falhar, a pessoa JÁ não autoriza.
  //        Fica a poder autenticar-se e a não ver nada — inconveniente,
  //        seguro, e visível na ficha;
  //      · se fosse ao contrário e o estado falhasse, ficava banida do login e
  //        a autorizar com a sessão aberta. O pior dos dois.
  //
  //    Não há transação comum entre o Postgres e a API de Auth. Como não se
  //    pode ter atomicidade, escolhe-se a ordem cujo estado intermedio é o
  //    seguro, e diz-se a verdade sobre ele. NÃO se compensa desfazendo o
  //    estado: desfazer devolveria autorização a quem se acabou de mandar
  //    embora.
  //
  //    Ambos os passos são idempotentes: repetir a operação com o estado já
  //    `inativo` e a conta já banida não muda nada e devolve `ok`.
  const { error: erroEstado } = await admin
    .from("profiles")
    .update({ status: novoEstado })
    .eq("id", pessoa.id);
  if (erroEstado) {
    return { ok: false, error: erroEstado.message };
  }

  const { error } = await admin.auth.admin.updateUserById(
    pessoa.auth_user_id as string, { ban_duration: "876000h" });
  if (error) {
    // O acesso JÁ está retirado — a base deixou de autorizar. O que falhou foi
    // o bloqueio do login, e diz-se isso, porque a pessoa ainda consegue
    // autenticar-se (e não ver nada).
    return {
      ok: false,
      error: "O acesso foi retirado, mas a conta não ficou bloqueada para " +
        "novos inicios de sessão. Repita a operação.",
    };
  }

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

  // 🔴 A ORDEM INVERSA DA DESACTIVAÇÃO, e pelo mesmo motivo.
  //
  //    A devolver acesso, o estado intermedio seguro é o que autoriza MENOS.
  //    Por isso tira-se primeiro o banimento e só depois se põe o estado em
  //    `ativo`: se o segundo passo falhar, a pessoa consegue autenticar-se e
  //    não autoriza — exactamente como estava antes de se carregar no botão.
  //
  //    Ao contrário, um `status = ativo` gravado com o banimento ainda por
  //    levantar daria autorização à sessão antiga sem que a pessoa pudesse
  //    sequer entrar de novo.
  const { error } = await admin.auth.admin.updateUserById(
    pessoa.auth_user_id as string, { ban_duration: "none" });
  if (error) return { ok: false, error: error.message };

  const { error: erroEstado } = await admin
    .from("profiles")
    .update({ status: ESTADO_AUTORIZADO })
    .eq("id", pessoa.id);
  if (erroEstado) {
    return {
      ok: false,
      error: "A conta foi desbloqueada, mas o estado não voltou a activo e a " +
        "pessoa continua sem autorização. Repita a operação.",
    };
  }

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
