"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth-guard";
import { canAccessService } from "@/lib/auth/can-access-service";
import {
  SERVICE_PHOTOS_BUCKET,
  isServicePhotoPathInCompany,
  type PhotoKind,
  type PhotoStatus,
} from "@/lib/service-photos";

export interface ServicePhoto {
  id: string;
  service_id: string;
  collaborator_id: string | null;
  storage_path: string;
  kind: PhotoKind;
  status: PhotoStatus;
  width: number | null;
  height: number | null;
  created_at: string;
  uploaded_at: string | null;
}

/** App da colaboradora: fotos do serviço (só se pertencer à equipa). */
export async function getServicePhotos(
  serviceId: string,
): Promise<{ ok: true; photos: ServicePhoto[] } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!profile) return { ok: false, error: "Perfil não encontrado" };

  const allowed = await canAccessService(admin, user.id, profile.company_id, serviceId, profile.role);
  if (!allowed) return { ok: false, error: "Sem permissão para aceder a este serviço." };

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

/**
 * Gera um signed URL de leitura para uma foto.
 * Colaboradoras: só podem aceder a fotos de serviços onde estão na equipa.
 * Gestoras: podem aceder a qualquer foto da empresa.
 */
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

  // Colaboradoras: verificar que o serviço a que a foto pertence é da sua equipa.
  // O path é: {companyId}/{serviceId}/{yyyy}/{mm}/{dd}/{clientEventId}.ext
  if (!["admin", "gestor"].includes(profile.role)) {
    const parts = storagePath.split("/");
    const serviceId = parts[1]; // índice 1 após company_id
    if (!serviceId) return { ok: false, error: "Caminho inválido." };

    const allowed = await canAccessService(admin, profile.id, profile.company_id, serviceId, profile.role);
    if (!allowed) return { ok: false, error: "Sem permissão para aceder a esta foto." };
  }

  const { data, error } = await admin.storage
    .from(SERVICE_PHOTOS_BUCKET)
    .createSignedUrl(storagePath, 3600);

  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link" };
  return { ok: true, url: data.signedUrl };
}
