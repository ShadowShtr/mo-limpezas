"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth-guard";
import {
  buildDamageReportNotificationRows,
  buildDocumentStoragePath,
  isStoragePathInCompany,
} from "@/lib/collaborator-documents";
import { revalidatePath } from "next/cache";

export type DocumentCategory =
  | "contrato"
  | "recibo_salario"
  | "identificacao"
  | "avaria"
  | "outro";

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

  if (error) return { ok: false, error: error.message };

  const documents: CollaboratorDocument[] = (data ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    file_url: d.file_url,
    file_size: d.file_size,
    mime_type: d.mime_type,
    category: d.category as DocumentCategory,
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

export async function uploadCollaboratorDocument(
  collaboratorId: string,
  companyId: string,
  file: FormData,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const fileObj  = file.get("file") as File | null;
  const category = (file.get("category") as string) ?? "outro";
  const notes    = (file.get("notes") as string) || null;
  const visibleStr = file.get("visible_to_collaborator") as string;
  const visible  = visibleStr === "true" || category === "recibo_salario";

  if (!fileObj) return { ok: false, error: "Ficheiro em falta" };
  if (fileObj.size > 50 * 1024 * 1024) return { ok: false, error: "Ficheiro demasiado grande (máx 50 MB)" };

  const path = buildDocumentStoragePath({ companyId, collaboratorId, fileName: fileObj.name });
  const admin = createAdminClient();

  await ensureBucket(admin);

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, fileObj, { contentType: fileObj.type, upsert: false });

  if (uploadError) return { ok: false, error: uploadError.message };

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
      category:                category as DocumentCategory,
      notes,
      visible_to_collaborator: visible,
      uploaded_by:             user.id,
      uploaded_by_role:        "gestor" as const,
      expires_at:              expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (dbError) return { ok: false, error: dbError.message };

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
    .single();

  if (fetchErr || !data) return { ok: false, error: "Documento não encontrado" };

  const bucketPrefix = `/${BUCKET}/`;
  const storagePath = data.file_url.includes(bucketPrefix) ? data.file_url.split(bucketPrefix)[1] : null;
  if (storagePath) {
    await admin.storage.from(BUCKET).remove([decodeURIComponent(storagePath)]);
  }

  const { error } = await admin
    .from("collaborator_documents")
    .delete()
    .eq("id", documentId)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/colaboradores/${collaboratorId}`);
  return { ok: true };
}

export async function getSignedDocumentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!fileUrl) return { ok: false, error: "URL do ficheiro em falta" };

  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const bucketPrefix = `/${BUCKET}/`;
  const storagePath = fileUrl.includes(bucketPrefix) ? fileUrl.split(bucketPrefix)[1] : null;

  if (!storagePath) return { ok: true, url: fileUrl };

  const decodedPath = decodeURIComponent(storagePath);
  // O path tem o formato `${companyId}/${collaboratorId}/...`
  if (!isStoragePathInCompany(decodedPath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
  }

  // Colaboradoras: verificar que o ficheiro lhes pertence E está visível.
  // Admin/gestor: acesso a qualquer documento da empresa.
  if (!["admin", "gestor"].includes(profile.role)) {
    // Segmento [1] do path é o collaboratorId
    const pathCollaboratorId = decodedPath.split("/")[1];
    if (!pathCollaboratorId || pathCollaboratorId !== profile.id) {
      return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
    }
    const { data: doc } = await admin
      .from("collaborator_documents")
      .select("visible_to_collaborator")
      .eq("company_id", profile.company_id)
      .eq("collaborator_id", profile.id)
      .eq("file_url", fileUrl)
      .maybeSingle();
    if (!doc?.visible_to_collaborator) {
      return { ok: false, error: "Este documento não está disponível para visualização." };
    }
  }

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(decodedPath, 3600);

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link" };
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

  if (error) return { ok: false, error: error.message };

  const documents: CollaboratorDocument[] = (data ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    file_url: d.file_url,
    file_size: d.file_size,
    mime_type: d.mime_type,
    category: d.category,
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

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + RETENTION_MONTHS);

    const { data, error: dbError } = await admin
      .from("collaborator_documents")
      .insert({
        company_id:              profile.company_id,
        collaborator_id:         user.id,
        file_name:               params.fileName,
        file_url:                params.publicUrl,
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
