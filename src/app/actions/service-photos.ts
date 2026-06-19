"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth-guard";
import {
  SERVICE_PHOTOS_BUCKET,
  isServicePhotoPathInCompany,
  type PhotoKind,
  type PhotoStatus,
} from "@/lib/service-photos";

export interface ServicePhoto {
  id: string;
  service_id: string;
  collaborator_id: string;
  storage_path: string;
  kind: PhotoKind;
  status: PhotoStatus;
  width: number | null;
  height: number | null;
  created_at: string;
  uploaded_at: string | null;
}

/** App da colaboradora: fotos de um serviço (próprias + as da equipa via metadata). */
export async function getServicePhotos(
  serviceId: string,
): Promise<{ ok: true; photos: ServicePhoto[] } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return { ok: false, error: "Perfil não encontrado" };

  const { data, error } = await admin
    .from("service_photos")
    .select("id, service_id, collaborator_id, storage_path, kind, status, width, height, created_at, uploaded_at")
    .eq("company_id", profile.company_id)
    .eq("service_id", serviceId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  return { ok: true, photos: (data ?? []) as ServicePhoto[] };
}

/** Dashboard (gestor): fotos de um serviço. */
export async function getServicePhotosForManager(
  serviceId: string,
): Promise<{ ok: true; photos: ServicePhoto[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("service_photos")
    .select("id, service_id, collaborator_id, storage_path, kind, status, width, height, created_at, uploaded_at")
    .eq("company_id", profile.company_id)
    .eq("service_id", serviceId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  return { ok: true, photos: (data ?? []) as ServicePhoto[] };
}

/** Gera um signed URL de leitura para um storage_path (curto, só da empresa). */
export async function getSignedServicePhotoUrl(
  storagePath: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!storagePath) return { ok: false, error: "Caminho em falta" };

  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  if (!isServicePhotoPathInCompany(storagePath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a esta foto." };
  }

  const { data, error } = await admin.storage
    .from(SERVICE_PHOTOS_BUCKET)
    .createSignedUrl(storagePath, 3600);

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link" };
  return { ok: true, url: data.signedUrl };
}
