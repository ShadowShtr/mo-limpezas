"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export interface CollaboratorDocument {
  id: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  category: "contrato" | "recibo_salario" | "identificacao" | "outro";
  created_at: string;
  uploaded_by_name: string | null;
}

export async function getCollaboratorDocuments(
  collaboratorId: string,
): Promise<{ ok: true; documents: CollaboratorDocument[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("collaborator_documents")
    .select("id, file_name, file_url, file_size, mime_type, category, created_at, uploaded_by")
    .eq("collaborator_id", collaboratorId)
    .order("created_at", { ascending: false });

  if (error) return { ok: false, error: error.message };

  const uploaderIds = [...new Set((data ?? []).map((d) => d.uploaded_by).filter(Boolean) as string[])];
  let names: Record<string, string> = {};
  if (uploaderIds.length > 0) {
    const { data: profiles } = await admin.from("profiles").select("id, full_name").in("id", uploaderIds);
    names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));
  }

  const documents: CollaboratorDocument[] = (data ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    file_url: d.file_url,
    file_size: d.file_size,
    mime_type: d.mime_type,
    category: d.category as CollaboratorDocument["category"],
    created_at: d.created_at,
    uploaded_by_name: d.uploaded_by ? (names[d.uploaded_by] ?? null) : null,
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

  const fileObj = file.get("file") as File | null;
  const category = (file.get("category") as string) ?? "outro";

  if (!fileObj) return { ok: false, error: "Ficheiro em falta" };

  const ext = fileObj.name.split(".").pop() ?? "";
  const path = `${companyId}/${collaboratorId}/${Date.now()}-${fileObj.name}`;

  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from("collaborator-documents")
    .upload(path, fileObj, { contentType: fileObj.type, upsert: false });

  if (uploadError) return { ok: false, error: uploadError.message };

  const { data: urlData } = admin.storage.from("collaborator-documents").getPublicUrl(path);

  const { data, error: dbError } = await admin
    .from("collaborator_documents")
    .insert({
      company_id: companyId,
      collaborator_id: collaboratorId,
      file_name: fileObj.name,
      file_url: urlData.publicUrl,
      file_size: fileObj.size,
      mime_type: fileObj.type,
      category: category as CollaboratorDocument["category"],
      uploaded_by: user.id,
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
  const admin = createAdminClient();

  const { data, error: fetchErr } = await admin
    .from("collaborator_documents")
    .select("file_url")
    .eq("id", documentId)
    .single();

  if (fetchErr || !data) return { ok: false, error: "Documento não encontrado" };

  // Extract storage path from public URL
  const url = data.file_url;
  const bucketPrefix = "/collaborator-documents/";
  const storagePath = url.includes(bucketPrefix) ? url.split(bucketPrefix)[1] : null;

  if (storagePath) {
    await admin.storage.from("collaborator-documents").remove([storagePath]);
  }

  const { error } = await admin.from("collaborator_documents").delete().eq("id", documentId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/colaboradores/${collaboratorId}`);
  return { ok: true };
}

export async function getSignedDocumentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const bucketPrefix = "/collaborator-documents/";
  const storagePath = fileUrl.includes(bucketPrefix) ? fileUrl.split(bucketPrefix)[1] : null;

  if (!storagePath) return { ok: true, url: fileUrl };

  const { data, error } = await admin.storage
    .from("collaborator-documents")
    .createSignedUrl(storagePath, 3600);

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link" };
  return { ok: true, url: data.signedUrl };
}
