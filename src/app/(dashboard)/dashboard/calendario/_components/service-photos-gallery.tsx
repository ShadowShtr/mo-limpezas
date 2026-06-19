"use client";

import { useEffect, useState, useCallback } from "react";
import { Camera, Loader2, ImageOff, ImageUp } from "lucide-react";
import {
  getServicePhotosForManager,
  getSignedServicePhotoUrl,
  type ServicePhoto,
} from "@/app/actions/service-photos";

// TASK 10 — Galeria leve por serviço (gestora). Thumbnails lazy; original só ao
// clicar. Nunca carrega imagem grande na lista.

const KIND_LABEL: Record<string, string> = {
  antes: "Antes", durante: "Durante", depois: "Depois", avaria: "Avaria", outro: "Foto",
};

export function ServicePhotosGallery({ serviceId }: { serviceId: string }) {
  const [photos, setPhotos] = useState<ServicePhoto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await getServicePhotosForManager(serviceId);
    setPhotos(res.ok ? res.photos : []);
    setLoading(false);
  }, [serviceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" /> A carregar fotos...
      </div>
    );
  }

  if (photos.length === 0) return null; // foto é ocasional — não mostrar secção vazia

  const uploaded = photos.filter((p) => p.status === "uploaded");
  const pending = photos.filter((p) => p.status === "pending" || p.status === "uploading");
  const failed = photos.filter((p) => p.status === "failed" || p.status === "review_required");

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Camera className="w-4 h-4 text-[var(--color-primary)]" />
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Fotos do serviço</p>
        <span className="text-xs text-[var(--color-text-muted)]">{uploaded.length}</span>
      </div>

      {uploaded.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {uploaded.map((p) => <Thumb key={p.id} photo={p} />)}
        </div>
      )}

      {(pending.length > 0 || failed.length > 0) && (
        <div className="mt-2 space-y-1">
          {pending.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <ImageUp className="w-3.5 h-3.5" /> {pending.length} foto(s) a aguardar envio do telemóvel
            </p>
          )}
          {failed.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-amber-600">
              <ImageOff className="w-3.5 h-3.5" /> {failed.length} foto(s) falharam no envio
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Thumb({ photo }: { photo: ServicePhoto }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function open() {
    if (url) { window.open(url, "_blank", "noopener,noreferrer"); return; }
    setLoading(true);
    const res = await getSignedServicePhotoUrl(photo.storage_path);
    setLoading(false);
    if (res.ok) {
      setUrl(res.url);
      window.open(res.url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      title={KIND_LABEL[photo.kind] ?? "Foto"}
      className="relative aspect-square rounded-lg overflow-hidden bg-[var(--color-border)] flex items-center justify-center group"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Foto do serviço" className="w-full h-full object-cover" loading="lazy" />
      ) : loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
      ) : (
        <Camera className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)]" />
      )}
    </button>
  );
}
