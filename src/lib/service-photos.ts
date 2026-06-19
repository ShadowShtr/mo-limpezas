// TASK 01/11 — Helpers partilhados das fotos de serviço (path + validação).
// Sem "use server" — exporta constantes e funções puras (testáveis).

export const SERVICE_PHOTOS_BUCKET = "service-photos";

/** Tamanho máximo aceite no backend (15 MB) — alinhado com o bucket. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** MIME types de imagem aceites (TASK 11). */
export const ALLOWED_PHOTO_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type PhotoKind = "antes" | "durante" | "depois" | "avaria" | "outro";
export const PHOTO_KINDS: PhotoKind[] = ["antes", "durante", "depois", "avaria", "outro"];

export type PhotoStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed"
  | "deleted"
  | "review_required";

/** Mapeia content-type para extensão de ficheiro (default jpg). */
export function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/jpeg":
    default:
      return "jpg";
  }
}

export function isAllowedPhotoMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return (ALLOWED_PHOTO_MIME as readonly string[]).includes(mime);
}

export function isValidPhotoKind(kind: string | null | undefined): kind is PhotoKind {
  return !!kind && (PHOTO_KINDS as string[]).includes(kind);
}

/**
 * Caminho do ficheiro no storage. Estrutura não previsível por nome original:
 *   company_id/service_id/yyyy/mm/dd/client_event_id.ext
 * O client_event_id (UUID) garante unicidade e idempotência em retry.
 */
export function buildServicePhotoPath(params: {
  companyId: string;
  serviceId: string;
  clientEventId: string;
  mimeType: string;
  now?: Date;
}): string {
  const d = params.now ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const ext = extForMime(params.mimeType);
  return `${params.companyId}/${params.serviceId}/${yyyy}/${mm}/${dd}/${params.clientEventId}.${ext}`;
}

/** Impede travessia de diretórios e cross-tenant ao assinar URLs de leitura. */
export function isServicePhotoPathInCompany(
  storagePath: string,
  companyId: string,
): boolean {
  if (!storagePath || !companyId) return false;
  if (storagePath.includes("..")) return false;
  return storagePath.startsWith(`${companyId}/`);
}

/** Validação central de um pedido de signed upload (frontend + backend). */
export function validatePhotoUploadRequest(input: {
  contentType?: string | null;
  sizeBytes?: number | null;
  kind?: string | null;
}): { ok: true } | { ok: false; error: string } {
  if (!isAllowedPhotoMime(input.contentType)) {
    return { ok: false, error: "Tipo de ficheiro não suportado. Use uma foto (JPG/PNG/WebP)." };
  }
  const size = Number(input.sizeBytes ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "Ficheiro vazio ou inválido." };
  }
  if (size > MAX_PHOTO_BYTES) {
    return { ok: false, error: "Foto demasiado grande. Tire outra foto e tente novamente." };
  }
  if (input.kind != null && !isValidPhotoKind(input.kind)) {
    return { ok: false, error: "Tipo de foto inválido." };
  }
  return { ok: true };
}
