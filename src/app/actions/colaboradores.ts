"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { auditLog } from "@/lib/audit";
import { isNoRowsError, logQueryFailure, queryFailure } from "@/lib/query-error";
import { sondarRelacoesDoPerfil } from "@/lib/collaborators/probe-profile-relations";
import { resolverIdentidadeAuth } from "@/lib/collaborators/auth-identity";
import {
  avaliarRemocao, explicarVeredicto, resumirPorArea,
} from "@/domain/collaborators/lifecycle";
import { ESTADO_DE_SAIDA } from "@/domain/collaborators/access-state";

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

  // 🔴 Estes cinco existiam no formulário e não existiam aqui. O `safeParse`
  //    deitava-os fora em silêncio e o INSERT nunca os via: escrevia-se o NIF,
  //    o IBAN, o valor à hora e as datas de contrato, gravava-se com sucesso, e
  //    a pessoa nascia sem nada disso. Perder o que alguém acabou de escrever é
  //    pior do que recusar guardar — ninguém vai lá confirmar.
  nif: z.string().max(20).optional(),
  iban: z.string().max(40).optional(),
  hourly_rate: z.number().min(0).max(10000).nullable().optional(),
  contract_start: z.string().optional().nullable(),
  contract_end: z.string().optional().nullable(),
});

/** Vazio é ausência, nunca `""` — um valor inventado é indistinguível de um real. */
const ouNulo = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

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
      // 🔴 O id da pessoa nasce aqui, no servidor.
      //
      //    `profiles.id` é PRIMARY KEY e **não tem DEFAULT**: durante anos veio
      //    de `auth.users.id`, porque criar uma pessoa era criar uma conta. Ao
      //    separar as duas coisas, o INSERT deixou de trazer id nenhum e a base
      //    respondia `null value in column "id" of relation "profiles"`.
      //
      //    Não se resolve pedindo um id ao Auth — isso repunha a dependência
      //    que o EXPAND existe para cortar, e criava uma conta a quem não a
      //    pediu. A pessoa tem identidade própria; a conta é opcional e vem
      //    depois.
      id: randomUUID(),
      company_id: companyId,
      role: parsed.data.role,
      full_name: parsed.data.full_name,
      email: ouNulo(parsed.data.email),
      phone: ouNulo(parsed.data.phone),
      nif: ouNulo(parsed.data.nif),
      iban: ouNulo(parsed.data.iban),
      hourly_rate: parsed.data.hourly_rate ?? null,
      contract_start: ouNulo(parsed.data.contract_start),
      contract_end: ouNulo(parsed.data.contract_end),
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

// ============================================================================
// SAÍDA DE UM COLABORADOR
// ============================================================================
//
// 🔴 O que estava aqui, e porque teve de sair.
//
//    `deleteColaborador` corria nove UPDATEs a anular autoria — serviços,
//    contratos, faltas, férias, faturas, folha — e só depois chamava
//    `deleteUser`. O catálogo tem QUARENTA E SEIS colunas a apontar para
//    `profiles`; o inventário gerado em `profile-fk-inventory.ts` lista-as
//    todas.
//
//    As trinta e sete que faltavam (fluxo de caixa, pagamentos fixos,
//    períodos financeiros, conciliação bancária, importações de extrato,
//    tarefas de gestão, documentos, funil de leads) bloqueavam o `deleteUser`
//    no fim. E quando bloqueavam, as nove primeiras já tinham sido anuladas:
//    o perfil ficava, e o histórico ficava sem autor. Era o estado proibido
//    — PROFILE_EXISTS e HISTORY_PARTIALLY_CLEARED ao mesmo tempo — e chegava
//    lá por um caminho normal, não por azar.
//
//    Não havia como fechá-lo com uma transação: a chave administrativa fala
//    por HTTP, cada pedido confirma-se sozinho, e o `deleteUser` do Auth nem
//    sequer é o mesmo sistema. Com nove escritas antes de um apagar que pode
//    recusar, alguma ordem de falha deixa sempre metade feita.
//
//    Por isso a correção não é uma transação. É deixar de haver escritas: a
//    saída de uma pessoa com histórico é uma DESATIVAÇÃO, e a desativação não
//    toca em autoria nenhuma. O estado proibido deixa de ser possível porque
//    deixa de ter onde nascer.
//
// A eliminação física sobrevive, mas só onde é inofensiva: um perfil criado
// por engano, sem uma única linha em parte alguma. E aí não há nada para
// limpar antes.
// ============================================================================

/** Quem pede, sobre quem, e se pode. Partilhado pelas três operações. */
async function resolverAlvoDeSaida(id: string, companyId: string) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Não autenticado." };

  const { data: caller } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!caller || !["admin", "gestor"].includes(caller.role)) {
    return { ok: false as const, error: "Sem permissão." };
  }
  if (caller.company_id !== companyId) return { ok: false as const, error: "Empresa inválida." };

  const { data: target, error: targetError } = await admin
    .from("profiles").select("id, company_id, full_name, status").eq("id", id).single();
  // Decide SOBRE QUEM se opera, e a verificação de empresa depende disto.
  if (targetError && !isNoRowsError(targetError)) {
    return queryFailure("saidaColaborador:target", targetError);
  }
  if (!target || target.company_id !== companyId) {
    return { ok: false as const, error: "Colaboradora inválida." };
  }

  return { ok: true as const, admin, actorId: user.id, target };
}

/**
 * O que acontece a esta pessoa se a quisermos tirar do sistema.
 *
 * Só lê. Existe para a interface poder dizer a verdade ANTES de alguém
 * carregar em alguma coisa — a caixa de confirmação antiga prometia «os
 * serviços e contratos ficam, sem a autoria», que era ao mesmo tempo o que
 * acontecia e aquilo que nunca devia ter acontecido.
 */
export async function avaliarSaidaColaborador(id: string, companyId: string) {
  const alvo = await resolverAlvoDeSaida(id, companyId);
  if (!alvo.ok) return alvo;

  const sondagens = await sondarRelacoesDoPerfil(alvo.admin, id);
  const veredicto = avaliarRemocao(sondagens);

  return {
    ok: true as const,
    nome: alvo.target.full_name,
    status: alvo.target.status as string,
    proprioUtilizador: alvo.actorId === id,
    veredicto,
    areas: resumirPorArea(veredicto.relacoes),
    explicacao: explicarVeredicto(veredicto, alvo.target.full_name),
    // A interface não decide isto sozinha: quem sabe que a eliminação está
    // suspensa é o servidor, e um ecrã que o inferisse por sua conta voltaria
    // a divergir da action no dia em que ela mudar.
    eliminacaoSuspensa: ELIMINACAO_FISICA_SUSPENSA,
  };
}

/**
 * Desativar: a saída normal.
 *
 * Tira o acesso e marca o perfil como inativo. Não apaga nada, não anula
 * nada, e é reversível — reativar devolve a mesma conta, não cria outra.
 *
 * 🔴 A ordem das duas escritas não é indiferente, e a razão é de segurança.
 *
 *    O banimento vem primeiro. Se o `status` falhar a seguir, a pessoa fica
 *    fora e o perfil continua a dizer «ativo»: visível, corrigível, e sem
 *    ninguém a entrar. Pela ordem contrária, uma falha deixaria o perfil
 *    marcado como inativo com a conta a funcionar — alguém que já saiu, a
 *    entrar, e a lista a garantir que não.
 *
 *    Nenhuma das ordens perde dados; só uma delas erra para o lado seguro.
 */
export async function desativarColaborador(id: string, companyId: string) {
  const alvo = await resolverAlvoDeSaida(id, companyId);
  if (!alvo.ok) return alvo;
  const { admin, actorId, target } = alvo;

  // Desativar-se a si própria trancava a porta por dentro: quem o fizesse
  // perdia o acesso e ficava sem forma de o repor.
  if (actorId === id) {
    return { ok: false as const, error: "Não podes desativar a tua própria conta." };
  }

  // 🔴 O id da conta NUNCA se assume igual ao do perfil.
  //
  //    O repositório tem dois modelos de identidade a coexistir, e escrever
  //    `getUserById(id)` aqui escolhia o legado em silêncio — na mesma
  //    aplicação onde `collaborator-access.ts` já usa `auth_user_id`. O
  //    resolver é o único sítio onde essa regra vive.
  const identidade = await resolverIdentidadeAuth(admin, id);
  if (!identidade.ok) return { ok: false as const, error: identidade.erro };

  // Um perfil pode nunca ter tido conta de acesso — foi criado com o nome e
  // mais nada. Não é uma avaria, e não impede a desativação.
  let contaBanida = false;
  if (identidade.authUserId) {
    const { data: conta } = await admin.auth.admin.getUserById(identidade.authUserId);
    if (conta?.user) {
      // Um banimento longo é a forma de o Supabase representar «não entra», e
      // preserva a conta — que é precisamente o que se quer.
      const { error: erroBan } = await admin.auth.admin.updateUserById(identidade.authUserId, {
        ban_duration: "876000h",
      });
      if (erroBan) return { ok: false as const, error: erroBan.message };
      contaBanida = true;
    }
  }

  // 🔴 O banimento sozinho NÃO tira o acesso, e é por isso que esta escrita é
  //    a que conta.
  //
  //    Banir impede o login seguinte; o access token já emitido continua
  //    válido até ao `exp`. Quem estivesse autenticado continuava a trabalhar.
  //    É `status` que `requireProfile`, os dois layouts e o proxy consultam a
  //    cada pedido — e é isso que torna a saída imediata.
  //
  //    Logo, se esta escrita falhar, a operação FALHOU, mesmo com a conta já
  //    banida. Dizer «acesso retirado» aqui seria repetir a promessa que esta
  //    task veio desfazer.
  const { error: erroEstado } = await admin
    .from("profiles").update({ status: ESTADO_DE_SAIDA })
    .eq("id", id).eq("company_id", companyId);
  if (erroEstado) {
    return {
      ok: false as const,
      error: "Não foi possível concluir a saída: o estado do perfil não ficou gravado. "
        + (contaBanida
          ? "A conta já não aceita entradas novas, mas uma sessão aberta pode continuar "
            + "a funcionar até repetir esta operação. "
          : "")
        + "Nada se perdeu — repita.",
    };
  }

  // E confirma-se que ficou mesmo. Um `update` sem erro que não encontrou
  // linha nenhuma devolve sucesso; auditar «desativado» sobre isso seria
  // registar uma coisa que não aconteceu.
  const { data: confirmacao, error: erroConfirmacao } = await admin
    .from("profiles").select("status").eq("id", id).maybeSingle();
  if (erroConfirmacao || !confirmacao
      || (confirmacao as { status?: string | null }).status !== ESTADO_DE_SAIDA) {
    return {
      ok: false as const,
      error: "A saída não ficou confirmada no perfil. Repita a operação — nada se perdeu.",
    };
  }

  await auditLog({
    companyId,
    actorId,
    action: "collaborator_deactivated",
    entityType: "profile",
    entityId: id,
    meta: {
      target_name: target.full_name,
      tinha_acesso: contaBanida,
      identidade: identidade.origem,
    },
    source: "dashboard",
  }, admin);

  revalidatePath("/dashboard/colaboradores");
  revalidatePath(`/dashboard/colaboradores/${id}`);
  revalidatePath("/dashboard/equipas");
  revalidatePath("/dashboard/calendario");
  return { ok: true as const, nome: target.full_name };
}

/**
 * Eliminar fisicamente — SUSPENSO.
 *
 * ===========================================================================
 * 🔴 Porque é que esta operação recusa sempre, e o que falta para voltar.
 * ===========================================================================
 *
 * O desenho era: sondar as 48 referências, e só apagar se TODAS vierem a
 * zero. As provas passavam. A conclusão «zero relações, logo apagar não
 * destrói nada» está certa — e não é atómica.
 *
 * Entre a sondagem e o apagar há duas chamadas HTTP separadas, e nada segura
 * a base entretanto. Outra pessoa, ou um cron, pode criar uma relação nesse
 * intervalo. O que acontece a seguir depende da referência:
 *
 *   · numa FK `RESTRICT`/`NO ACTION`, a base recusa o DELETE. A corrida é
 *     desagradável mas não perde nada — foi a integridade referencial que
 *     salvou a operação, não este código;
 *
 *   · numa FK `ON DELETE CASCADE` — e há catorze delas: ponto, faltas,
 *     férias, folha, equipas, reforços, notificações, documentos — a base
 *     NÃO recusa. Apaga a linha nova em silêncio, junto com o perfil.
 *
 * Ou seja: `NO_DATA_LOSS` estava provado para uma sequência sem concorrência,
 * e por provar debaixo dela. Não é uma falha teórica; é o mesmo tipo de
 * defeito que esta branch veio fechar — uma garantia afirmada num sítio onde
 * não podia ser cumprida.
 *
 * Fechá-lo a sério exige que a decisão e o apagar aconteçam no mesmo
 * instante, dentro da base: um `DELETE` que verifique as 48 referências na
 * própria instrução, ou um trigger em `profiles` que recuse. Qualquer das
 * duas é schema, e a 102 não abre aqui.
 *
 * Até lá, a operação retira-se em vez de ficar «quase certa». O que se perde
 * é a capacidade de apagar um perfil criado por engano — que fica desativado,
 * fora das equipas, das escalas e da folha, e sem acesso. O que se ganha é
 * não haver um caminho na aplicação que possa apagar um registo que alguém
 * acabou de criar.
 *
 * A função continua aqui, a recusar, e não foi apagada de propósito: é o
 * sítio onde a razão está escrita, e o ensaio que a obriga a recusar é o que
 * impede alguém de reintroduzir um apagar ingénuo por baixo.
 *
 * Para reabrir: garantia atómica na base + o ensaio de corrida
 * («sondagem a zero → nasce relação CASCADE → tentar apagar → perfil e
 * relação sobrevivem») a passar contra ela.
 *
 * 🔴 Não exportado. Um ficheiro `"use server"` só pode exportar funções
 *    assíncronas — exportar esta constante rebentaria em runtime com «a
 *    "use server" file can only export async functions», e o `tsc` não o
 *    apanha. Quem precisa do valor recebe-o dentro do resultado de
 *    `avaliarSaidaColaborador`.
 */
const ELIMINACAO_FISICA_SUSPENSA = true;

export async function deleteColaborador(id: string, companyId: string) {
  // A autorização corre na mesma, e primeiro: quem não podia pedir isto
  // continua a não poder, e a recusa que recebe é a dele, não esta.
  const alvo = await resolverAlvoDeSaida(id, companyId);
  if (!alvo.ok) return alvo;
  const { admin, actorId, target } = alvo;

  if (actorId === id) return { ok: false as const, error: "Não podes excluir a tua própria conta." };

  // A sondagem corre para a mensagem poder ser verdadeira sobre este caso
  // concreto — mas o resultado dela já não autoriza nada.
  const sondagens = await sondarRelacoesDoPerfil(admin, id);
  const veredicto = avaliarRemocao(sondagens);

  if (!veredicto.elegivel) {
    return {
      ok: false as const,
      error: explicarVeredicto(veredicto, target.full_name),
      codigo: veredicto.codigo,
      areas: resumirPorArea(veredicto.relacoes),
    };
  }

  return {
    ok: false as const,
    codigo: "ELIMINACAO_SUSPENSA" as const,
    areas: [],
    error:
      `${target.full_name} não tem registos no sistema, mas a eliminação definitiva está `
      + "suspensa: entre a verificação e o apagar, alguém pode criar um registo que seria "
      + "apagado com o perfil. Até isso ficar garantido pela base de dados, a saída faz-se "
      + "por desativação — a pessoa deixa de entrar e sai das equipas, escalas e folha.",
  };
}
