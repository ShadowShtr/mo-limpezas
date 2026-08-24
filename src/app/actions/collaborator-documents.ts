"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth-guard";
import {
  buildDamageReportNotificationRows,
  buildDocumentStoragePath,
  isStoragePathInCompany,
} from "@/lib/collaborator-documents";
import { isNoRowsError, queryFailure, logQueryFailure } from "@/lib/query-error";
import { revalidatePath } from "next/cache";

export const DOCUMENT_CATEGORIES = [
  "contrato",
  "recibo_salario",
  "identificacao",
  "avaria",
  "outro",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * 🔴 Substitui `category as DocumentCategory`.
 *
 * Um `as` não valida nada — é uma afirmação ao compilador, não uma verificação
 * em execução. O valor chega de um `FormData` do browser, portanto podia ser
 * qualquer string e ia inteira para a coluna. Devolve `null` para desconhecido;
 * quem chama recusa **antes** de escrever no storage.
 */
export function parseDocumentCategory(value: unknown): DocumentCategory | null {
  return typeof value === "string"
    && (DOCUMENT_CATEGORIES as readonly string[]).includes(value)
    ? (value as DocumentCategory)
    : null;
}

export interface CollaboratorDocument {
  id: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  category: DocumentCategory;
  notes: string | null;
  visible_to_collaborator: boolean;
  uploaded_by_role: "gestor" | "colaboradora";
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  uploaded_by_name: string | null;
}

const BUCKET = "collaborator-documents";
const RETENTION_MONTHS = 3;

async function ensureBucket(admin: ReturnType<typeof createAdminClient>) {
  const { error } = await admin.storage.getBucket(BUCKET);
  if (error) {
    // Criar sem restrição de MIME types — permite qualquer formato (HEIC, PDF, etc.)
    await admin.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: 52428800,
    });
  }
}

// ─── Dashboard (gestor) ───────────────────────────────────────────────────────

export async function getCollaboratorDocuments(
  collaboratorId: string,
): Promise<{ ok: true; documents: CollaboratorDocument[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const { data, error } = await admin
    .from("collaborator_documents")
    .select("id, file_name, file_url, file_size, mime_type, category, notes, visible_to_collaborator, uploaded_by_role, expires_at, archived_at, created_at, profiles!uploaded_by(full_name)")
    .eq("collaborator_id", collaboratorId)
    .eq("company_id", guard.profile.company_id)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  // Uma falha aqui não pode virar "este colaborador não tem documentos".
  if (error) return queryFailure("getCollaboratorDocuments", error);

  const documents: CollaboratorDocument[] = (data ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    file_url: d.file_url,
    file_size: d.file_size,
    mime_type: d.mime_type,
    category: parseDocumentCategory(d.category) ?? "outro",
    notes: d.notes,
    visible_to_collaborator: d.visible_to_collaborator,
    uploaded_by_role: d.uploaded_by_role as "gestor" | "colaboradora",
    expires_at: d.expires_at,
    archived_at: d.archived_at,
    created_at: d.created_at,
    uploaded_by_name: (d.profiles as { full_name?: string } | null)?.full_name ?? null,
  }));

  return { ok: true, documents };
}

/**
 * Carrega um documento para a ficha de uma colaboradora.
 *
 * 🔴 A fronteira de confiança estava no sítio errado. A versão anterior:
 *
 *     uploadCollaboratorDocument(collaboratorId, companyId, file)
 *       → só verificava que havia sessão, sem papel nenhum
 *       → usava o `companyId` **do browser** como dono do registo
 *       → escrevia com o cliente administrativo
 *
 * Ou seja: qualquer sessão autenticada podia depositar um ficheiro na ficha de
 * qualquer pessoa de qualquer empresa, escolhendo o destino no pedido. O
 * cliente administrativo ignora RLS — era a única barreira que restava, e não
 * estava lá.
 *
 * Agora o browser envia uma **intenção** (para quem, que categoria) e o
 * servidor resolve o **contexto** (que empresa, com que autoridade). O
 * `companyId` deixou de fazer parte da entrada: um parâmetro que não se pode
 * acreditar não deve existir.
 */
export async function uploadCollaboratorDocument(
  collaboratorId: string,
  file: FormData,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // O alvo é legítimo como entrada — mas tem de ser provado dentro da empresa
  // de quem está a carregar. A recusa é a mesma para "não existe" e para "é de
  // outra empresa": distinguir confirmaria a existência de perfis alheios.
  const { data: alvo, error: alvoErr } = await admin
    .from("profiles")
    .select("id")
    .eq("id", collaboratorId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (alvoErr && !isNoRowsError(alvoErr)) {
    return queryFailure("uploadCollaboratorDocument:collaborator", alvoErr);
  }
  if (!alvo) return { ok: false, error: "Colaborador não encontrado." };

  const fileObj  = file.get("file") as File | null;
  const category = parseDocumentCategory(file.get("category") ?? "outro");
  const notes    = (file.get("notes") as string) || null;
  const visibleStr = file.get("visible_to_collaborator") as string;

  if (!category) return { ok: false, error: "Categoria de documento inválida." };
  if (!fileObj) return { ok: false, error: "Ficheiro em falta" };
  if (fileObj.size > 50 * 1024 * 1024) return { ok: false, error: "Ficheiro demasiado grande (máx 50 MB)" };

  const visible = visibleStr === "true" || category === "recibo_salario";

  // O caminho é derivado no servidor, dos valores que o servidor resolveu.
  // Nunca de um caminho enviado pelo browser.
  const path = buildDocumentStoragePath({ companyId, collaboratorId, fileName: fileObj.name });

  await ensureBucket(admin);

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, fileObj, { contentType: fileObj.type, upsert: false });

  if (uploadError) {
    logQueryFailure("uploadCollaboratorDocument:storage", uploadError);
    return { ok: false, error: "Não foi possível guardar o ficheiro. Tenta novamente." };
  }

  const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(path);

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + RETENTION_MONTHS);

  const { data, error: dbError } = await admin
    .from("collaborator_documents")
    .insert({
      company_id:              companyId,
      collaborator_id:         collaboratorId,
      file_name:               fileObj.name,
      file_url:                urlData.publicUrl,
      file_size:               fileObj.size,
      mime_type:               fileObj.type,
      category,
      notes,
      visible_to_collaborator: visible,
      uploaded_by:             guard.profile.id,
      uploaded_by_role:        "gestor" as const,
      expires_at:              expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (dbError) {
    // 🔴 Compensação. Storage e base de dados não partilham transação: sem isto,
    //    uma falha no `insert` deixava o ficheiro no bucket sem registo que o
    //    apontasse — invisível na aplicação, presente no armazenamento, e sem
    //    nada que o ligasse a ninguém.
    //
    //    Remove-se **exatamente** o objeto que este pedido acabou de criar.
    //    Nunca um prefixo, nunca uma pasta.
    const { error: limpezaErr } = await admin.storage.from(BUCKET).remove([path]);
    if (limpezaErr) {
      console.error("[storage:orphan] ficheiro sem registo em collaborator_documents", {
        bucket: BUCKET,
        path,
        motivo: dbError.code ?? null,
      });
    }
    logQueryFailure("uploadCollaboratorDocument:insert", dbError);
    return { ok: false, error: "Não foi possível registar o documento. Tenta novamente." };
  }

  revalidatePath(`/dashboard/colaboradores/${collaboratorId}`);
  return { ok: true, id: data.id };
}

export async function deleteCollaboratorDocument(
  documentId: string,
  collaboratorId: string,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data, error: fetchErr } = await admin
    .from("collaborator_documents")
    .select("file_url")
    .eq("id", documentId)
    .eq("company_id", profile.company_id)
    .maybeSingle();

  // Uma consulta falhada não é um documento inexistente. Antes, `fetchErr ||
  // !data` dava a mesma resposta para as duas — e a segunda leitura é a que
  // faz alguém carregar outra vez, e outra vez.
  if (fetchErr && !isNoRowsError(fetchErr)) {
    return queryFailure("deleteCollaboratorDocument:fetch", fetchErr);
  }
  if (!data) return { ok: false, error: "Documento não encontrado" };

  const bucketPrefix = `/${BUCKET}/`;
  const storagePath = data.file_url.includes(bucketPrefix) ? data.file_url.split(bucketPrefix)[1] : null;

  if (storagePath) {
    const decoded = decodeURIComponent(storagePath);

    // Cinto de segurança: mesmo vindo da base, o caminho tem de estar dentro
    // da empresa antes de se apagar seja o que for.
    if (!isStoragePathInCompany(decoded, profile.company_id)) {
      return { ok: false, error: "Sem permissão para apagar este ficheiro." };
    }

    // 🔴 O resultado deixou de ser ignorado. Antes, uma falha a apagar do
    //    storage não impedia o `delete` na base: o ficheiro ficava no bucket e
    //    o registo que o apontava desaparecia — ninguém na aplicação voltava a
    //    saber que ele existia, nem para o apagar.
    //
    //    Das duas inconsistências possíveis, esta é a que se escolhe evitar.
    //    Ficheiro sem registo é invisível e permanente; registo sem ficheiro é
    //    visível, e recuperável por quem olhar.
    const { error: storageErr } = await admin.storage.from(BUCKET).remove([decoded]);
    if (storageErr) {
      logQueryFailure("deleteCollaboratorDocument:storage", storageErr);
      return { ok: false, error: "Não foi possível apagar o ficheiro. Nada foi removido." };
    }
  }

  const { error } = await admin
    .from("collaborator_documents")
    .delete()
    .eq("id", documentId)
    .eq("company_id", profile.company_id);
  if (error) return queryFailure("deleteCollaboratorDocument:delete", error);

  revalidatePath(`/dashboard/colaboradores/${collaboratorId}`);
  return { ok: true };
}

/**
 * Devolve um link temporário para ver um documento.
 *
 * 🔴 O caminho a assinar **nunca** vem do browser. A versão anterior extraía o
 *    caminho da string recebida e assinava-o depois de verificar o prefixo da
 *    empresa — o que impedia atravessar empresas, mas ainda deixava assinar
 *    qualquer objeto dentro do próprio prefixo, incluindo ficheiros sem
 *    registo nenhum na base.
 *
 *    Agora o `fileUrl` é só uma **chave de procura**: resolve-se o documento na
 *    base, dentro da empresa do ator, e assina-se o caminho que o registo diz.
 *    Um URL sem documento correspondente não se assina.
 */
export async function getSignedDocumentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!fileUrl) return { ok: false, error: "URL do ficheiro em falta" };

  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const ehGestor = ["admin", "gestor"].includes(profile.role);

  let consulta = admin
    .from("collaborator_documents")
    .select("file_url, collaborator_id, visible_to_collaborator")
    .eq("company_id", profile.company_id)
    .eq("file_url", fileUrl);

  // A colaboradora só resolve os seus próprios documentos, e só os que lhe
  // foram tornados visíveis. O filtro vai na consulta: o que não é dela não
  // chega sequer a ser lido.
  if (!ehGestor) {
    consulta = consulta
      .eq("collaborator_id", profile.id)
      .eq("visible_to_collaborator", true);
  }

  const { data: doc, error: docErr } = await consulta.maybeSingle();

  if (docErr && !isNoRowsError(docErr)) {
    return queryFailure("getSignedDocumentUrl:document", docErr);
  }
  if (!doc) return { ok: false, error: "Sem permissão para aceder a este ficheiro." };

  const bucketPrefix = `/${BUCKET}/`;
  const storagePath = doc.file_url.includes(bucketPrefix)
    ? doc.file_url.split(bucketPrefix)[1]
    : null;

  // Documentos antigos podem ter um `file_url` que não aponta para este bucket.
  // Nesse caso não há nada para assinar — devolve-se o que está registado.
  if (!storagePath) return { ok: true, url: doc.file_url };

  const decodedPath = decodeURIComponent(storagePath);

  // Cinto de segurança sobre o valor da própria base: um registo com caminho
  // fora da empresa não se assina, venha ele de onde vier.
  if (!isStoragePathInCompany(decodedPath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
  }

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(decodedPath, 3600);

  if (error || !data) {
    logQueryFailure("getSignedDocumentUrl:sign", error);
    return { ok: false, error: "Não foi possível gerar o link. Tenta novamente." };
  }
  return { ok: true, url: data.signedUrl };
}

// ─── App da colaboradora ──────────────────────────────────────────────────────

export async function getMyDocuments(): Promise<{
  ok: boolean;
  documents?: CollaboratorDocument[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("collaborator_documents")
    .select("id, file_name, file_url, file_size, mime_type, category, notes, visible_to_collaborator, uploaded_by_role, expires_at, archived_at, created_at")
    .eq("collaborator_id", user.id)
    .eq("visible_to_collaborator", true)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  // Uma falha aqui não pode aparecer como "não tens documentos".
  if (error) return queryFailure("getMyDocuments", error);

  const documents: CollaboratorDocument[] = (data ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    file_url: d.file_url,
    file_size: d.file_size,
    mime_type: d.mime_type,
    category: parseDocumentCategory(d.category) ?? "outro",
    notes: d.notes,
    visible_to_collaborator: d.visible_to_collaborator,
    uploaded_by_role: d.uploaded_by_role,
    expires_at: d.expires_at,
    archived_at: d.archived_at,
    created_at: d.created_at,
    uploaded_by_name: null,
  }));

  return { ok: true, documents };
}

export async function uploadDamageReport(formData: FormData): Promise<{
  ok: boolean;
  id?: string;
  error?: string;
}> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Não autenticado" };

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .single();
    if (!profile) return { ok: false, error: "Perfil não encontrado" };

    const file  = formData.get("file") as File | null;
    const notes = (formData.get("notes") as string) || null;

    if (!file) return { ok: false, error: "Ficheiro obrigatório" };
    if (file.size > 50 * 1024 * 1024) return { ok: false, error: "Ficheiro demasiado grande (máx 50 MB)" };

    const path = buildDocumentStoragePath({
      companyId: profile.company_id,
      collaboratorId: user.id,
      fileName: file.name,
    });

    await ensureBucket(admin);

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });

    if (uploadError) return { ok: false, error: uploadError.message };

    const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(path);

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + RETENTION_MONTHS);

    const { data, error: dbError } = await admin
      .from("collaborator_documents")
      .insert({
        company_id:              profile.company_id,
        collaborator_id:         user.id,
        file_name:               file.name,
        file_url:                urlData.publicUrl,
        file_size:               file.size,
        mime_type:               file.type,
        category:                "avaria" as const,
        notes,
        visible_to_collaborator: true,
        uploaded_by:             user.id,
        uploaded_by_role:        "colaboradora" as const,
        expires_at:              expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (dbError) return { ok: false, error: dbError.message };

    // Notificar todos os gestores/admins da empresa
    const [{ data: collaboratorProfile }, { data: managers }] = await Promise.all([
      admin.from("profiles").select("full_name").eq("id", user.id).single(),
      admin.from("profiles").select("id").eq("company_id", profile.company_id).in("role", ["gestor", "admin"]),
    ]);

    if (managers && managers.length > 0) {
      await admin.from("notifications").insert(buildDamageReportNotificationRows({
        companyId: profile.company_id,
        collaboratorId: user.id,
        collaboratorName: collaboratorProfile?.full_name,
        documentId: data.id,
        notes,
        managers,
      }));
    }

    revalidatePath("/app/perfil");
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao enviar. Tente novamente." };
  }
}

// ─── Upload direto (celular → Supabase sem passar pelo servidor) ──────────────

/** Passo 1: gera URL assinada para o celular fazer upload direto ao Supabase. */
export async function getDamageReportUploadUrl(
  fileName: string,
): Promise<{ ok: true; signedUrl: string; token: string; path: string; publicUrl: string } | { ok: false; error: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Não autenticado" };

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles").select("company_id").eq("id", user.id).single();
    if (!profile) return { ok: false, error: "Perfil não encontrado" };

    const path = buildDocumentStoragePath({
      companyId: profile.company_id,
      collaboratorId: user.id,
      fileName,
    });

    // ensureBucket removido do caminho de upload — adiciona latência desnecessária em prod
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: error?.message ?? "Bucket não configurado. Contacta o gestor." };

    const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(path);
    return { ok: true, signedUrl: data.signedUrl, token: data.token, path, publicUrl: urlData.publicUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro interno" };
  }
}

/** Passo 2: após o celular fazer upload direto, guarda o registo na BD e notifica gestores. */
export async function saveDamageReportRecord(params: {
  path: string;
  publicUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  notes: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Não autenticado" };

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles").select("company_id").eq("id", user.id).single();
    if (!profile) return { ok: false, error: "Perfil não encontrado" };

    // 🔴 `path` e `publicUrl` chegam do browser — foram devolvidos por
    //    `getDamageReportUploadUrl`, mas nada garante que voltem intactos.
    //    O caminho tem de estar dentro da empresa **e** pertencer a quem está a
    //    gravar, e o URL é recalculado a partir dele: aceitar o `publicUrl` do
    //    pedido deixava um registo apontar para um ficheiro que não foi este
    //    upload.
    if (!isStoragePathInCompany(params.path, profile.company_id)
        || params.path.split("/")[1] !== user.id) {
      return { ok: false, error: "Caminho de ficheiro inválido." };
    }

    const { data: urlDerivado } = admin.storage.from(BUCKET).getPublicUrl(params.path);

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + RETENTION_MONTHS);

    const { data, error: dbError } = await admin
      .from("collaborator_documents")
      .insert({
        company_id:              profile.company_id,
        collaborator_id:         user.id,
        file_name:               params.fileName,
        file_url:                urlDerivado.publicUrl,
        file_size:               params.fileSize,
        mime_type:               params.mimeType,
        category:                "avaria" as const,
        notes:                   params.notes,
        visible_to_collaborator: true,
        uploaded_by:             user.id,
        uploaded_by_role:        "colaboradora" as const,
        expires_at:              expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (dbError) return { ok: false, error: dbError.message };

    const [{ data: collaboratorProfile }, { data: managers }] = await Promise.all([
      admin.from("profiles").select("full_name").eq("id", user.id).single(),
      admin.from("profiles").select("id").eq("company_id", profile.company_id).in("role", ["gestor", "admin"]),
    ]);

    if (managers && managers.length > 0) {
      await admin.from("notifications").insert(buildDamageReportNotificationRows({
        companyId: profile.company_id,
        collaboratorId: user.id,
        collaboratorName: collaboratorProfile?.full_name,
        documentId: data.id,
        notes: params.notes,
        managers,
      }));
    }

    revalidatePath("/app/perfil");
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao guardar registo." };
  }
}

// ─── Backup ZIP (gestor) ─────────────────────────────────────────────────────

export interface BackupDocument {
  collaborator_name: string;
  category: DocumentCategory;
  file_name: string;
  notes: string | null;
  signed_url: string;
  file_size: number | null;
}

export async function getDocumentsForBackup(): Promise<{
  ok: boolean;
  company_name?: string;
  documents?: BackupDocument[];
  expiring_count?: number;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile) return { ok: false, error: "Perfil não encontrado" };
  if (!["gestor", "admin"].includes(profile.role)) return { ok: false, error: "Sem permissão" };

  const { data: company } = await admin
    .from("companies")
    .select("name")
    .eq("id", profile.company_id)
    .single();

  const { data: docs, error } = await admin
    .from("collaborator_documents")
    .select("id, file_name, file_url, file_size, category, notes, collaborator_id, expires_at")
    .eq("company_id", profile.company_id)
    .is("archived_at", null)
    .order("collaborator_id")
    .order("created_at");

  if (error) return { ok: false, error: error.message };
  if (!docs || docs.length === 0) {
    return { ok: true, company_name: company?.name, documents: [], expiring_count: 0 };
  }

  const collabIds = [...new Set(docs.map((d) => d.collaborator_id))];
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, full_name")
    .in("id", collabIds);
  const nameMap = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));

  const thirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const expiring_count = docs.filter(
    (d) => d.expires_at && new Date(d.expires_at).getTime() < thirtyDays,
  ).length;

  const bucketPrefix = `/${BUCKET}/`;
  const documents = await Promise.all(
    docs.map(async (doc) => {
      const storagePath = doc.file_url.includes(bucketPrefix)
        ? decodeURIComponent(doc.file_url.split(bucketPrefix)[1])
        : null;

      let signed_url = doc.file_url;
      if (storagePath) {
        const { data: urlData } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, 7200);
        if (urlData) signed_url = urlData.signedUrl;
      }

      return {
        collaborator_name: nameMap[doc.collaborator_id] ?? "Desconhecida",
        category: doc.category,
        file_name: doc.file_name,
        notes: doc.notes,
        signed_url,
        file_size: doc.file_size,
      } satisfies BackupDocument;
    }),
  );

  return { ok: true, company_name: company?.name, documents, expiring_count };
}

// ─── Arquivo de documentos expirados (cron) ───────────────────────────────────

export async function listDocumentsToArchive(_companyId?: string): Promise<{
  ok: boolean;
  documents?: (CollaboratorDocument & { collaborator_name: string })[];
  error?: string;
}> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const { data, error } = await admin.rpc("get_documents_to_archive", {
    p_company_id: guard.profile.company_id,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, documents: (data ?? []) as (CollaboratorDocument & { collaborator_name: string })[] };
}

export async function archiveExpiredDocuments(_companyId?: string): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data: expired } = await admin
    .from("collaborator_documents")
    .select("id, file_url")
    .eq("company_id", companyId)
    .lt("expires_at", new Date().toISOString())
    .is("archived_at", null);

  const docs = expired ?? [];

  const paths = docs
    .map((d) => {
      const prefix = `/${BUCKET}/`;
      return d.file_url.includes(prefix) ? decodeURIComponent(d.file_url.split(prefix)[1]) : null;
    })
    .filter((p): p is string => p !== null);

  if (paths.length > 0) {
    await admin.storage.from(BUCKET).remove(paths);
  }

  const { error } = await admin
    .from("collaborator_documents")
    .update({ archived_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .lt("expires_at", new Date().toISOString())
    .is("archived_at", null);

  if (error) return { ok: false, error: error.message };
  return { ok: true, count: docs.length };
}
