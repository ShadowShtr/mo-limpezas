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
  const { data } = await admin
    .from("platform_admins")
    .select("profile_id")
    .eq("profile_id", profileId)
    .maybeSingle();
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
export async function getPendingNotices(): Promise<NoticeForDisplay[]> {
  try {
    const guard = await requireProfile();
    if (!guard.ok) return [];
    const { admin, profile } = guard;

    const { data: lidos, error: lidosErro } = await admin
      .from("app_notice_reads")
      .select("notice_key")
      .eq("profile_id", profile.id);
    if (lidosErro) throw lidosErro;

    const jaLidas = new Set((lidos ?? []).map((r) => r.notice_key));

    // `created_at` não vem no guard partilhado (`AuthedProfile` só traz id,
    // company_id e role) — lê-se aqui em vez de alargar um tipo que dezenas de
    // actions usam.
    const { data: perfilRow } = await admin
      .from("profiles")
      .select("created_at")
      .eq("id", profile.id)
      .maybeSingle();

    // ── Notas de release (código) ──
    const releases = releasesPorMostrar(
      RELEASE_NOTES,
      perfilRow?.created_at ?? new Date(0).toISOString(),
      jaLidas,
    );

    // ── Avisos manuais (base) ──
    const { data: manuaisRaw, error: manuaisErro } = await admin
      .from("app_notices")
      .select("id, notice_key, kind, title, message, audience, published_at")
      .not("published_at", "is", null)
      .is("archived_at", null);
    if (manuaisErro) throw manuaisErro;

    const candidatos = (manuaisRaw ?? []).filter((n) => !jaLidas.has(n.notice_key));

    // Quem é alvo de quê. `audience = 'all'` não tem linhas — não se
    // materializa a lista de toda a gente.
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
        return alvos.some(
          (a) => a.profile_id === profile.id || a.company_id === profile.company_id,
        );
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
  } catch (e) {
    // A camada de avisos não é essencial ao dashboard. Falhar aqui deixa a
    // página utilizável; mascarar o erro deixaria o defeito invisível.
    console.error("[update-notices] getPendingNotices falhou:", e);
    return [];
  }
}

/**
 * Marca um aviso como lido pelo perfil da sessão.
 *
 * Idempotente pela chave primária `(profile_id, notice_key)`: dois cliques ou
 * dois separadores não criam duas linhas, e a segunda tentativa devolve
 * sucesso em vez de erro — o utilizador leu, e é isso que interessa.
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
  const leiturasPorChave = new Map<string, number>();
  if (chaves.length > 0) {
    const { data: reads } = await admin
      .from("app_notice_reads")
      .select("notice_key")
      .in("notice_key", chaves);
    for (const r of reads ?? []) {
      leiturasPorChave.set(r.notice_key, (leiturasPorChave.get(r.notice_key) ?? 0) + 1);
    }
  }

  const { count: totalPerfis } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "ativo");

  const alvosPorAviso = new Map<string, number>();
  const dirigidos = (notices ?? []).filter((n) => n.audience !== "all").map((n) => n.id);
  if (dirigidos.length > 0) {
    const { data: alvos } = await admin
      .from("app_notice_targets")
      .select("notice_id, company_id, profile_id")
      .in("notice_id", dirigidos);

    const empresas = [...new Set((alvos ?? []).map((a) => a.company_id).filter(Boolean) as string[])];
    const perfisPorEmpresa = new Map<string, number>();
    if (empresas.length > 0) {
      const { data: perfis } = await admin
        .from("profiles")
        .select("company_id")
        .in("company_id", empresas)
        .eq("status", "ativo");
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

  const companyIds = input.companyIds ?? [];
  const profileIds = input.profileIds ?? [];
  if (input.audience === "companies" && companyIds.length === 0) {
    return { ok: false, error: "Escolhe pelo menos uma empresa." };
  }
  if (input.audience === "profiles" && profileIds.length === 0) {
    return { ok: false, error: "Escolhe pelo menos um perfil." };
  }

  const noticeKey = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const publishedAt = new Date().toISOString();

  const { data: criado, error: criarErro } = await admin
    .from("app_notices")
    .insert({
      notice_key: noticeKey,
      kind: input.kind,
      title,
      message,
      audience: input.audience,
      published_at: publishedAt,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (criarErro || !criado) {
    return { ok: false, error: criarErro?.message ?? "Não foi possível publicar o aviso." };
  }

  if (input.audience !== "all") {
    const linhas: { notice_id: string; company_id: string | null; profile_id: string | null }[] =
      input.audience === "companies"
        ? companyIds.map((c) => ({ notice_id: criado.id, company_id: c, profile_id: null }))
        : profileIds.map((p) => ({ notice_id: criado.id, company_id: null, profile_id: p }));

    const { error: alvosErro } = await admin.from("app_notice_targets").insert(linhas);
    if (alvosErro) {
      // Compensação: um aviso publicado sem destinatários chegaria a ninguém
      // e ficaria no histórico como se tivesse chegado.
      await admin.from("app_notices").delete().eq("id", criado.id);
      return { ok: false, error: alvosErro.message };
    }
  }

  const recipients = await contarDestinatarios(admin, input.audience, companyIds, profileIds);

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

  return { ok: true, count: await contarDestinatarios(admin, audience, companyIds, profileIds) };
}

async function contarDestinatarios(
  admin: Admin,
  audience: NoticeAudience,
  companyIds: string[],
  profileIds: string[],
): Promise<number> {
  if (audience === "profiles") return profileIds.length;

  if (audience === "companies") {
    if (companyIds.length === 0) return 0;
    const { count } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("company_id", companyIds)
      .eq("status", "ativo");
    return count ?? 0;
  }

  const { count } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "ativo");
  return count ?? 0;
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

  const { data: companies } = await admin.from("companies").select("id, name").order("name");
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, full_name, company_id")
    .eq("status", "ativo")
    .order("full_name");

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
