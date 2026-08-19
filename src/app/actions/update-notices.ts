"use server";

// ============================================================================
// AVISOS DE ATUALIZAÇÃO — actions
// ============================================================================
// Duas fontes (notas em código, avisos manuais na base) que convergem numa
// lista só, com um registo de leitura partilhado por `notice_key`.
//
// 🔴 O que este ficheiro tem de garantir:
//
//   1. **Administração de plataforma é verificada no servidor.** Esconder o
//      menu não é autorização. `requireProfile` só sabe de papéis dentro de um
//      tenant — publicar para várias empresas exige `platform_admins`, e é
//      revalidado em cada action que publica.
//
//   2. **Ninguém marca leituras por outra pessoa.** O `profile_id` sai sempre
//      da sessão, nunca de um argumento.
//
//   3. **Nada de leituras falsas.** Notas antigas não são marcadas como lidas
//      para «limpar» o backlog — a elegibilidade decide o que se entrega, e as
//      restantes voltam no ciclo seguinte.
// ============================================================================

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { RELEASE_NOTES } from "@/release-notes";
import {
  isNoticeAudience,
  isNoticeKind,
  NOTICE_MESSAGE_MAX,
  NOTICE_TITLE_MAX,
  type NoticeAudience,
  type NoticeForDisplay,
  type NoticeKind,
} from "@/domain/update-notices/types";
import {
  releasesPorMostrar,
  selecionarCiclo,
} from "@/domain/update-notices/eligibility";

type Guard = Awaited<ReturnType<typeof requireProfile>>;
type Admin = Extract<Guard, { ok: true }>["admin"];

/**
 * 🔴 A verificação de administração de plataforma.
 *
 * Uma consulta a `platform_admins` pelo `profile_id` da sessão. Não aceita
 * argumento: o id vem sempre de quem está autenticado.
 */
async function ehPlatformAdmin(admin: Admin, profileId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("platform_admins")
    .select("profile_id")
    .eq("profile_id", profileId)
    .maybeSingle();

  // 🔴 FAIL CLOSED, e deliberadamente. Falhar a ler não é prova de que a
  //    pessoa é administradora — na dúvida, não é. O erro é registado para não
  //    ficar invisível se a tabela desaparecer ou a chave expirar.
  if (error) {
    console.error("[update-notices] verificação de platform_admin falhou:", error.message);
    return false;
  }
  return Boolean(data);
}

export async function isPlatformAdmin(): Promise<boolean> {
  const guard = await requireProfile();
  if (!guard.ok) return false;
  return ehPlatformAdmin(guard.admin, guard.profile.id);
}

/**
 * Os avisos por mostrar a quem está autenticado, já em ordem de apresentação.
 *
 * ⚠️ Chamada em cada abertura do dashboard: falhar aqui não pode derrubar a
 *    página. Um erro devolve lista vazia — a aplicação continua utilizável e o
 *    aviso aparece na próxima. O erro é registado, não engolido em silêncio.
 */
/**
 * O ciclo actual, **sem rede de segurança**.
 *
 * 🔴 A mesma lógica de `getPendingNotices`, mas propaga erros em vez de
 *    devolver lista vazia. É a diferença entre «não há nada para mostrar» e
 *    «não consegui saber»: para pintar um dashboard, o primeiro serve; para
 *    autorizar uma escrita, não.
 *
 *    `markNoticeAsRead` usa esta versão — se a leitura falhar, recusa em vez
 *    de gravar uma confirmação sobre um aviso que não conseguiu verificar.
 */
async function resolverCicloEstrito(
  admin: Admin,
  profileId: string,
  companyId: string,
): Promise<NoticeForDisplay[]> {
  const { data: lidos, error: lidosErro } = await admin
    .from("app_notice_reads")
    .select("notice_key")
    .eq("profile_id", profileId);
  if (lidosErro) throw lidosErro;

  const jaLidas = new Set((lidos ?? []).map((r) => r.notice_key));

  const { data: perfilRow, error: perfilErro } = await admin
    .from("profiles")
    .select("created_at")
    .eq("id", profileId)
    .maybeSingle();
  if (perfilErro) throw perfilErro;
  if (!perfilRow) throw new Error("Perfil não encontrado.");

  const releases = releasesPorMostrar(RELEASE_NOTES, perfilRow.created_at, jaLidas);

  const { data: manuaisRaw, error: manuaisErro } = await admin
    .from("app_notices")
    .select("id, notice_key, kind, title, message, audience, published_at")
    .not("published_at", "is", null)
    .is("archived_at", null);
  if (manuaisErro) throw manuaisErro;

  const candidatos = (manuaisRaw ?? []).filter((n) => !jaLidas.has(n.notice_key));

  const dirigidos = candidatos.filter((n) => n.audience !== "all").map((n) => n.id);
  const alvosPorAviso = new Map<string, { company_id: string | null; profile_id: string | null }[]>();
  if (dirigidos.length > 0) {
    const { data: alvos, error: alvosErro } = await admin
      .from("app_notice_targets")
      .select("notice_id, company_id, profile_id")
      .in("notice_id", dirigidos);
    if (alvosErro) throw alvosErro;
    for (const a of alvos ?? []) {
      alvosPorAviso.set(a.notice_id, [...(alvosPorAviso.get(a.notice_id) ?? []), a]);
    }
  }

  const manuais: NoticeForDisplay[] = candidatos
    .filter((n) => {
      if (n.audience === "all") return true;
      const alvos = alvosPorAviso.get(n.id) ?? [];
      return alvos.some((a) => a.profile_id === profileId || a.company_id === companyId);
    })
    .map((n) => ({
      key: n.notice_key,
      kind: n.kind as NoticeKind,
      title: n.title,
      message: n.message,
      publishedAt: n.published_at as string,
      source: "manual" as const,
    }));

  return selecionarCiclo([...manuais, ...releases]);
}

export async function getPendingNotices(): Promise<NoticeForDisplay[]> {
  try {
    const guard = await requireProfile();
    if (!guard.ok) return [];

    return await resolverCicloEstrito(guard.admin, guard.profile.id, guard.profile.company_id);
  } catch (e) {
    // A camada de avisos não é essencial ao dashboard: falhar aqui deixa a
    // página utilizável, e o aviso volta na próxima abertura. O erro é
    // registado — mascará-lo deixaria o defeito invisível.
    //
    // 🔴 Só esta função engole o erro. `markNoticeAsRead` usa o resolver
    //    directamente, porque autorizar uma escrita sobre «não consegui
    //    saber» é diferente de pintar um dashboard sem avisos.
    console.error("[update-notices] getPendingNotices falhou:", e);
    return [];
  }
}

/**
 * Marca um aviso como lido pelo perfil da sessão.
 *
 * 🔴 A chave é VALIDADA contra o ciclo actual daquele perfil.
 *
 *    A versão anterior aceitava qualquer string. Alguém que chamasse esta
 *    action directamente podia marcar como lida:
 *
 *      · uma release ainda fora do lote — que desaparecia sem nunca ter sido
 *        mostrada, e o utilizador nunca sabia o que mudou;
 *      · um aviso manual dirigido a outra empresa;
 *      · uma chave inventada, poluindo a tabela.
 *
 *    Uma leitura tem de significar «esta pessoa confirmou um aviso que lhe foi
 *    entregue», não «esta pessoa enviou uma string».
 *
 * Idempotente: a segunda chamada devolve sucesso sem criar segunda linha. E
 * uma chave já lida passa mesmo que já não esteja no ciclo — o dois cliques
 * seguidos é o caso normal, não um ataque.
 */
export async function markNoticeAsRead(
  noticeKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!noticeKey || typeof noticeKey !== "string") {
    return { ok: false, error: "Aviso inválido." };
  }

  // Já lido: idempotência antes de tudo. Sai do ciclo assim que é marcado, e
  // exigir que ainda lá estivesse faria o segundo clique falhar.
  const { data: jaLido, error: jaLidoErro } = await admin
    .from("app_notice_reads")
    .select("notice_key")
    .eq("profile_id", profile.id)
    .eq("notice_key", noticeKey)
    .maybeSingle();
  if (jaLidoErro) return { ok: false, error: jaLidoErro.message };
  if (jaLido) return { ok: true };

  // Resolver estrito: se a leitura falhar, recusa — não grava uma confirmação
  // sobre um aviso que não conseguiu verificar.
  let ciclo: NoticeForDisplay[];
  try {
    ciclo = await resolverCicloEstrito(admin, profile.id, profile.company_id);
  } catch (e) {
    console.error("[update-notices] markNoticeAsRead: ciclo indisponível:", e);
    return { ok: false, error: "Não foi possível confirmar a leitura. Tenta outra vez." };
  }

  if (!ciclo.some((n) => n.key === noticeKey)) {
    // Mensagem igual para chave inexistente, fora do lote ou de outro tenant:
    // distingui-las revelaria a existência de avisos alheios.
    return { ok: false, error: "Este aviso não está disponível para este perfil." };
  }

  // 🔴 `profile_id` da sessão, nunca de argumento: ninguém marca por outro.
  const { error } = await admin
    .from("app_notice_reads")
    .upsert(
      { profile_id: profile.id, notice_key: noticeKey },
      { onConflict: "profile_id,notice_key", ignoreDuplicates: true },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── Painel de plataforma ────────────────────────────────────────────────────

export interface NoticeListItem {
  id: string;
  noticeKey: string;
  kind: NoticeKind;
  title: string;
  message: string;
  audience: NoticeAudience;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  /** Quantos perfis já o leram — agregado no servidor, nunca no cliente. */
  reads: number;
  /** Quantos perfis o deviam receber. */
  recipients: number;
}

export async function listNotices(): Promise<
  { ok: true; notices: NoticeListItem[] } | { ok: false; error: string }
> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!(await ehPlatformAdmin(admin, profile.id))) {
    return { ok: false, error: "Sem permissão." };
  }

  const { data: notices, error } = await admin
    .from("app_notices")
    .select("id, notice_key, kind, title, message, audience, published_at, archived_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return { ok: false, error: error.message };

  const chaves = (notices ?? []).map((n) => n.notice_key);

  // Contagem de leituras em lote — carregar todas as linhas para o cliente só
  // para as contar seria um problema no dia em que houver milhares.
  // 🔴 A partir daqui, um erro de query NÃO pode virar zero.
  //
  //    «3 de 40 leram» construído sobre uma leitura falhada é pior do que um
  //    erro: o painel afirmaria um número que ninguém pode verificar, e a
  //    decisão de republicar um aviso sairia dele.
  const leiturasPorChave = new Map<string, number>();
  if (chaves.length > 0) {
    const { data: reads, error: readsErro } = await admin
      .from("app_notice_reads")
      .select("notice_key")
      .in("notice_key", chaves);
    if (readsErro) return { ok: false, error: readsErro.message };
    for (const r of reads ?? []) {
      leiturasPorChave.set(r.notice_key, (leiturasPorChave.get(r.notice_key) ?? 0) + 1);
    }
  }

  const { count: totalPerfis, error: totalErro } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "ativo");
  if (totalErro) return { ok: false, error: totalErro.message };

  const alvosPorAviso = new Map<string, number>();
  const dirigidos = (notices ?? []).filter((n) => n.audience !== "all").map((n) => n.id);
  if (dirigidos.length > 0) {
    const { data: alvos, error: alvosErro } = await admin
      .from("app_notice_targets")
      .select("notice_id, company_id, profile_id")
      .in("notice_id", dirigidos);
    if (alvosErro) return { ok: false, error: alvosErro.message };

    const empresas = [...new Set((alvos ?? []).map((a) => a.company_id).filter(Boolean) as string[])];
    const perfisPorEmpresa = new Map<string, number>();
    if (empresas.length > 0) {
      const { data: perfis, error: perfisErro } = await admin
        .from("profiles")
        .select("company_id")
        .in("company_id", empresas)
        .eq("status", "ativo");
      if (perfisErro) return { ok: false, error: perfisErro.message };
      for (const p of perfis ?? []) {
        perfisPorEmpresa.set(p.company_id, (perfisPorEmpresa.get(p.company_id) ?? 0) + 1);
      }
    }

    for (const a of alvos ?? []) {
      const n = a.company_id ? (perfisPorEmpresa.get(a.company_id) ?? 0) : 1;
      alvosPorAviso.set(a.notice_id, (alvosPorAviso.get(a.notice_id) ?? 0) + n);
    }
  }

  return {
    ok: true,
    notices: (notices ?? []).map((n) => ({
      id: n.id,
      noticeKey: n.notice_key,
      kind: n.kind as NoticeKind,
      title: n.title,
      message: n.message,
      audience: n.audience as NoticeAudience,
      publishedAt: n.published_at,
      archivedAt: n.archived_at,
      createdAt: n.created_at,
      reads: leiturasPorChave.get(n.notice_key) ?? 0,
      recipients: n.audience === "all" ? (totalPerfis ?? 0) : (alvosPorAviso.get(n.id) ?? 0),
    })),
  };
}

export interface PublishNoticeInput {
  kind: string;
  title: string;
  message: string;
  audience: string;
  companyIds?: string[];
  profileIds?: string[];
}

/**
 * Publica um aviso. Só administração de plataforma.
 *
 * `published_at` é definido **no servidor** — a data de publicação não é algo
 * que o cliente proponha.
 */
export async function publishNotice(
  input: PublishNoticeInput,
): Promise<{ ok: true; noticeKey: string; recipients: number } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!(await ehPlatformAdmin(admin, profile.id))) {
    return { ok: false, error: "Sem permissão." };
  }

  // Validação no servidor, não só no formulário.
  if (!isNoticeKind(input.kind)) return { ok: false, error: "Tipo inválido." };
  if (!isNoticeAudience(input.audience)) return { ok: false, error: "Destinatários inválidos." };

  const title = (input.title ?? "").trim();
  const message = (input.message ?? "").trim();
  if (!title) return { ok: false, error: "O título é obrigatório." };
  if (!message) return { ok: false, error: "A mensagem é obrigatória." };
  if (title.length > NOTICE_TITLE_MAX) return { ok: false, error: `Título com mais de ${NOTICE_TITLE_MAX} caracteres.` };
  if (message.length > NOTICE_MESSAGE_MAX) return { ok: false, error: `Mensagem com mais de ${NOTICE_MESSAGE_MAX} caracteres.` };

  // 🔴 VALIDAR E CONTAR ANTES DE QUALQUER ESCRITA.
  //
  //    A versão anterior publicava e só depois tentava contar, devolvendo
  //    `recipients = -1` com `ok: true` se a contagem falhasse. Isso é publicar
  //    sem saber para quem — e apresentar isso como sucesso. O número de
  //    destinatários é determinável antes de escrever, portanto é antes de
  //    escrever que se determina.
  //
  //    Se isto falhar, não nasce nem o rascunho.
  let recipients: number;
  let companyIds: string[];
  let profileIds: string[];
  try {
    const r = await validarEContarDestinatarios(
      admin, input.audience, input.companyIds ?? [], input.profileIds ?? [],
    );
    recipients = r.count;
    companyIds = r.companyIds;
    profileIds = r.profileIds;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Não foi possível apurar os destinatários." };
  }

  const noticeKey = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Publicação em duas fases ──────────────────────────────────────────────
  //
  // 🔴 Nasce como RASCUNHO (`published_at = NULL`), invisível para toda a
  //    gente. Só depois de os destinatários estarem gravados é que passa a
  //    publicado.
  //
  //    A versão anterior gravava `published_at` no primeiro INSERT e
  //    compensava com um DELETE se os alvos falhassem. Isso deixava uma janela
  //    real: entre os dois passos, um aviso dirigido a uma empresa estava
  //    publicado **sem alvos** — e um aviso publicado sem alvos ou não chega a
  //    ninguém, ou chega a toda a gente, conforme quem o lê. Um crash entre os
  //    dois passos deixava-o assim para sempre, e a compensação era ela própria
  //    uma operação que podia falhar.
  //
  //    Agora o pior caso é um rascunho invisível.
  const { data: criado, error: criarErro } = await admin
    .from("app_notices")
    .insert({
      notice_key: noticeKey,
      kind: input.kind,
      title,
      message,
      audience: input.audience,
      published_at: null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (criarErro || !criado) {
    return { ok: false, error: criarErro?.message ?? "Não foi possível criar o aviso." };
  }

  if (input.audience !== "all") {
    const linhas: { notice_id: string; company_id: string | null; profile_id: string | null }[] =
      input.audience === "companies"
        ? companyIds.map((c) => ({ notice_id: criado.id, company_id: c, profile_id: null }))
        : profileIds.map((p) => ({ notice_id: criado.id, company_id: null, profile_id: p }));

    const { error: alvosErro } = await admin.from("app_notice_targets").insert(linhas);
    if (alvosErro) {
      // Limpeza do rascunho. Se falhar, fica um rascunho órfão — invisível
      // para os utilizadores, ao contrário de um publicado sem destinatários.
      await admin.from("app_notices").delete().eq("id", criado.id);
      return { ok: false, error: alvosErro.message };
    }
  }

  // Só agora se torna visível. `published_at` é definido no servidor.
  const { error: publicarErro } = await admin
    .from("app_notices")
    .update({ published_at: new Date().toISOString() })
    .eq("id", criado.id);

  if (publicarErro) {
    // Continua rascunho: não chegou a ninguém, e o painel mostra-o como tal.
    return { ok: false, error: publicarErro.message };
  }

  // `recipients` já é conhecido desde antes da primeira escrita.
  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "update_notice_published",
    entityType: "app_notice",
    entityId: criado.id,
    meta: { noticeKey, kind: input.kind, audience: input.audience, recipients },
  }, admin);

  revalidatePath("/dashboard");
  return { ok: true, noticeKey, recipients };
}

/** Quantos perfis activos recebem — calculado no servidor. */
export async function countRecipients(
  audience: string,
  companyIds: string[] = [],
  profileIds: string[] = [],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!(await ehPlatformAdmin(admin, profile.id))) {
    return { ok: false, error: "Sem permissão." };
  }
  if (!isNoticeAudience(audience)) return { ok: false, error: "Destinatários inválidos." };

  try {
    // A MESMA função que a publicação usa: o número mostrado no preview é o
    // número que a publicação revalida. Duas regras separadas divergiriam.
    const { count } = await validarEContarDestinatarios(admin, audience, companyIds, profileIds);
    return { ok: true, count };
  } catch (e) {
    // O painel esconde a contagem em vez de mostrar um zero inventado.
    return { ok: false, error: e instanceof Error ? e.message : "Não foi possível contar os destinatários." };
  }
}

/**
 * 🔴 A ÚNICA fonte de verdade sobre destinatários — valida e conta de uma vez.
 *
 * O preview («será enviado para N perfis») e a publicação usam esta mesma
 * função. Duas regras separadas divergiriam, e o número mostrado antes de
 * publicar deixaria de corresponder ao que acontece.
 *
 * Lança em erro em vez de devolver zero: «0 perfis» sobre uma query falhada é
 * uma frase falsa apresentada como facto. Quem chama traduz num erro visível —
 * e `publishNotice` chama isto **antes** de escrever, para que uma contagem
 * impossível de apurar não produza sequer um rascunho.
 */
async function validarEContarDestinatarios(
  admin: Admin,
  audience: NoticeAudience,
  companyIdsIn: string[],
  profileIdsIn: string[],
): Promise<{ count: number; companyIds: string[]; profileIds: string[] }> {
  // Deduplicar primeiro: o selector do cliente não é garantia de unicidade, e
  // ids repetidos inflavam a contagem.
  const companyIds = [...new Set(companyIdsIn)];
  const profileIds = [...new Set(profileIdsIn)];

  if (audience === "profiles") {
    if (profileIds.length === 0) throw new Error("Escolhe pelo menos um perfil.");

    // 🔴 Só perfis ACTIVOS. Validar apenas «o id existe» deixava passar um
    //    perfil inactivo: cinco ids seleccionados, três pessoas alcançáveis, e
    //    o painel dizia cinco.
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .in("id", profileIds)
      .eq("status", "ativo");
    if (error) throw error;
    if ((data ?? []).length !== profileIds.length) {
      throw new Error("Um dos perfis seleccionados não existe ou não está activo.");
    }
    return { count: profileIds.length, companyIds: [], profileIds };
  }

  if (audience === "companies") {
    if (companyIds.length === 0) throw new Error("Escolhe pelo menos uma empresa.");

    const { data: existem, error: existemErro } = await admin
      .from("companies").select("id").in("id", companyIds);
    if (existemErro) throw existemErro;
    if ((existem ?? []).length !== companyIds.length) {
      throw new Error("Uma das empresas seleccionadas não existe.");
    }

    const { count, error } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("company_id", companyIds)
      .eq("status", "ativo");
    if (error) throw error;
    return { count: count ?? 0, companyIds, profileIds: [] };
  }

  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "ativo");
  if (error) throw error;
  return { count: count ?? 0, companyIds: [], profileIds: [] };
}

/** Empresas e perfis para o selector de destinatários. */
export async function getAudienceOptions(): Promise<
  | { ok: true; companies: { id: string; name: string }[]; profiles: { id: string; name: string; company: string }[] }
  | { ok: false; error: string }
> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!(await ehPlatformAdmin(admin, profile.id))) {
    return { ok: false, error: "Sem permissão." };
  }

  // Falhar aqui daria um selector vazio, indistinguível de «não há empresas
  // nem perfis» — e alguém publicaria para «Todos» por não encontrar o alvo.
  const { data: companies, error: companiesErro } = await admin
    .from("companies").select("id, name").order("name");
  if (companiesErro) return { ok: false, error: companiesErro.message };

  const { data: profiles, error: profilesErro } = await admin
    .from("profiles")
    .select("id, full_name, company_id")
    .eq("status", "ativo")
    .order("full_name");
  if (profilesErro) return { ok: false, error: profilesErro.message };

  const nomeEmpresa = new Map((companies ?? []).map((c) => [c.id, c.name]));

  return {
    ok: true,
    companies: (companies ?? []).map((c) => ({ id: c.id, name: c.name })),
    // Nome e empresa chegam; nada mais — o selector não precisa de contactos
    // nem de dados laborais.
    profiles: (profiles ?? []).map((p) => ({
      id: p.id,
      name: p.full_name,
      company: nomeEmpresa.get(p.company_id) ?? "—",
    })),
  };
}

/** Arquivar retira o aviso de circulação sem apagar o que já foi lido. */
export async function archiveNotice(
  noticeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!(await ehPlatformAdmin(admin, profile.id))) {
    return { ok: false, error: "Sem permissão." };
  }

  const { error } = await admin
    .from("app_notices")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", noticeId);
  if (error) return { ok: false, error: error.message };

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "update_notice_archived",
    entityType: "app_notice",
    entityId: noticeId,
  }, admin);

  revalidatePath("/dashboard");
  return { ok: true };
}
