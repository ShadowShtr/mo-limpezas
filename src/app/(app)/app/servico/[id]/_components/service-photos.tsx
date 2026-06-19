"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, Loader2, CheckCircle, CloudOff, AlertTriangle, ImageIcon, RefreshCw } from "lucide-react";
import { compressClientImage } from "@/lib/images/compress-client-image";
import { validatePhotoUploadRequest } from "@/lib/service-photos";
import {
  enqueueUpload,
  getAllUploads,
  removeUpload,
  type QueuedUpload,
} from "@/lib/offline/upload-queue";
import { processUploadQueue, startUploadQueueWatcher } from "@/lib/offline/upload-runner";
import {
  getServicePhotos,
  getSignedServicePhotoUrl,
  type ServicePhoto,
} from "@/app/actions/service-photos";

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Props {
  serviceId: string;
  initialPhotos: ServicePhoto[];
}

// TASK 04/05 — Foto separada do ponto. Falha de foto nunca bloqueia a colaboradora.
export function ServicePhotos({ serviceId, initialPhotos }: Props) {
  const [photos, setPhotos] = useState<ServicePhoto[]>(initialPhotos);
  const [queued, setQueued] = useState<QueuedUpload[]>([]);
  const [busy, setBusy] = useState<"compressing" | null>(null);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshQueue = useCallback(async () => {
    const all = await getAllUploads();
    setQueued(all.filter((u) => u.service_id === serviceId && u.status !== "uploaded"));
  }, [serviceId]);

  const refreshPhotos = useCallback(async () => {
    const res = await getServicePhotos(serviceId);
    if (res.ok) setPhotos(res.photos);
  }, [serviceId]);

  useEffect(() => {
    // Sincroniza com sistemas externos (IndexedDB + servidor); setState só
    // ocorre após await, não de forma síncrona.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshQueue();
    const stop = startUploadQueueWatcher(20_000);
    // Após processar a fila, recarrega estado periodicamente.
    const id = window.setInterval(() => {
      void refreshQueue();
      void refreshPhotos();
    }, 15_000);
    return () => {
      stop();
      window.clearInterval(id);
    };
  }, [refreshQueue, refreshPhotos]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;

    // TASK 11 — validar tipo/tamanho antes de comprimir (UX rápida; o backend
    // valida de novo ao assinar). Bloqueia vídeo, PDF, ficheiro vazio, etc.
    if (!file.type.startsWith("image/")) {
      setMessage({ type: "error", text: "Só é possível enviar fotos (não vídeos nem ficheiros)." });
      return;
    }
    if (file.size === 0) {
      setMessage({ type: "error", text: "A foto parece vazia. Tire outra foto e tente novamente." });
      return;
    }
    // Limite generoso antes da compressão (o original pode ser grande).
    if (file.size > 40 * 1024 * 1024) {
      setMessage({ type: "error", text: "Foto demasiado grande. Tire outra foto e tente novamente." });
      return;
    }

    setMessage(null);
    setBusy("compressing");
    try {
      const compressed = await compressClientImage(file);

      // Após comprimir, validar contra o limite final aceite pelo backend.
      const check = validatePhotoUploadRequest({
        contentType: compressed.mimeType,
        sizeBytes: compressed.compressedSize,
        kind: "durante",
      });
      if (!check.ok) {
        setBusy(null);
        setMessage({ type: "error", text: check.error });
        return;
      }
      const clientEventId = uuid();
      const ok = await enqueueUpload({
        client_event_id: clientEventId,
        service_id: serviceId,
        kind: "durante",
        blob: compressed.blob,
        fileName: compressed.fileName,
        mimeType: compressed.mimeType,
        width: compressed.width,
        height: compressed.height,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
      });
      setBusy(null);

      if (!ok) {
        setMessage({ type: "error", text: "Não conseguimos preparar esta foto. Tire outra foto e tente novamente." });
        return;
      }

      await refreshQueue();
      if (typeof navigator !== "undefined" && navigator.onLine) {
        setMessage({ type: "success", text: "A enviar foto…" });
        void processUploadQueue().then(() => {
          void refreshQueue();
          void refreshPhotos();
        });
      } else {
        setMessage({ type: "success", text: "Foto guardada no telemóvel. Será enviada quando houver internet." });
      }
    } catch {
      setBusy(null);
      setMessage({ type: "error", text: "Não conseguimos preparar esta foto. Tire outra foto e tente novamente." });
    }
  }

  async function retryItem(item: QueuedUpload) {
    await removeUpload(item.client_event_id);
    await enqueueUpload({ ...item, status: "queued" });
    await refreshQueue();
    void processUploadQueue().then(() => { void refreshQueue(); void refreshPhotos(); });
  }

  function openPicker() {
    if (fileRef.current) fileRef.current.value = "";
    fileRef.current?.click();
  }

  const uploadedCount = photos.filter((p) => p.status === "uploaded").length;

  return (
    <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Camera className="w-4 h-4 text-[var(--color-primary)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-main)] flex-1">Fotos do serviço</h3>
        {uploadedCount > 0 && (
          <span className="text-xs bg-[var(--color-primary-light)] text-[var(--color-primary)] px-1.5 py-0.5 rounded-full font-medium">
            {uploadedCount}
          </span>
        )}
      </div>

      {/* Fotos enviadas (thumbnails lazy) */}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <PhotoThumb key={p.id} photo={p} />
          ))}
        </div>
      )}

      {/* Fotos em fila / pendentes / falhadas */}
      {queued.map((q) => (
        <div key={q.client_event_id} className="flex items-center gap-2 text-xs rounded-lg px-3 py-2 bg-[var(--color-primary-light)]">
          {q.status === "uploading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-primary)] shrink-0" />}
          {q.status === "queued" && <CloudOff className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />}
          {(q.status === "failed" || q.status === "needs_user_action") && <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
          <span className="flex-1 text-[var(--color-text-sub)]">
            {q.status === "uploading" && "A enviar foto…"}
            {q.status === "queued" && "Foto pendente por falta de rede."}
            {q.status === "failed" && "Não conseguimos enviar agora."}
            {q.status === "needs_user_action" && (q.lastError || "Não conseguimos enviar. Toque para tentar novamente.")}
          </span>
          {(q.status === "failed" || q.status === "needs_user_action") && (
            <button
              type="button"
              onClick={() => retryItem(q)}
              className="flex items-center gap-1 text-[var(--color-primary)] font-medium"
            >
              <RefreshCw className="w-3 h-3" /> Tentar
            </button>
          )}
        </div>
      ))}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />

      <button
        type="button"
        onClick={openPicker}
        disabled={busy === "compressing"}
        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)] text-sm font-semibold active:opacity-80 disabled:opacity-50 transition-opacity"
      >
        {busy === "compressing"
          ? <><Loader2 className="w-4 h-4 animate-spin" /> A preparar foto…</>
          : <><Camera className="w-4 h-4" /> Adicionar Foto</>}
      </button>

      {message && (
        <p className={`text-xs px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function PhotoThumb({ photo }: { photo: ServicePhoto }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function open() {
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
      className="relative aspect-square rounded-lg overflow-hidden bg-[var(--color-border)] flex items-center justify-center"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Foto" className="w-full h-full object-cover" loading="lazy" />
      ) : loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
      ) : photo.status === "uploaded" ? (
        <ImageIcon className="w-5 h-5 text-[var(--color-text-muted)]" />
      ) : (
        <CheckCircle className="w-5 h-5 text-[var(--color-text-muted)]" />
      )}
    </button>
  );
}
