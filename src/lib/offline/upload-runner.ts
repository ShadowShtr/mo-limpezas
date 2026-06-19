// TASK 03/09 — Orquestra o envio das fotos em fila (compress já feito no enqueue):
//   sign → fetch PUT (direto ao Supabase Storage) → confirm → remove da fila.
// Inclui backoff entre tentativas e estados finais (não faz retry infinito).
// Nota: uploadToSignedUrl do SDK não tem timeout/cancel — substituído por fetch PUT
// com AbortController (60s) para não bloquear indefinidamente em mobile.

import {
  getPendingUploads,
  getAllUploads,
  markUploading,
  markUploaded,
  markFailed,
  markNeedsUserAction,
  updateUpload,
  type QueuedUpload,
} from "@/lib/offline/upload-queue";

const MAX_ATTEMPTS = 5;
// Backoff por nº de tentativas já feitas (TASK 09): imediata, 10s, 30s, 2min.
const BACKOFF_MS = [0, 10_000, 30_000, 120_000];

let running = false;

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

async function signUpload(item: QueuedUpload) {
  const res = await fetch("/api/app/uploads/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: item.service_id,
      kind: item.kind,
      filename: item.fileName,
      content_type: item.mimeType,
      size_bytes: item.compressedSize,
      client_event_id: item.client_event_id,
      width: item.width,
      height: item.height,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data } as {
    status: number;
    data: { signed_url?: string; token?: string; storage_path?: string; bucket?: string; duplicate?: boolean; error?: string };
  };
}

async function confirmUpload(item: QueuedUpload, status: "uploaded" | "failed", failureReason?: string) {
  await fetch("/api/app/uploads/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_event_id: item.client_event_id,
      status,
      compressed_size_bytes: item.compressedSize,
      failure_reason: failureReason,
    }),
  });
}

/** Processa um item. Devolve true se ficou resolvido (uploaded ou ação do user). */
async function processItem(item: QueuedUpload): Promise<boolean> {
  // Respeitar backoff entre tentativas.
  if (item.lastRetryAt && Date.now() - item.lastRetryAt < backoffFor(item.attempts)) {
    return false;
  }

  await markUploading(item.client_event_id);

  try {
    const { status, data } = await signUpload(item);

    if (data.duplicate) {
      await markUploaded(item.client_event_id);
      return true;
    }

    // Erros que não devem fazer retry automático (ação do utilizador).
    if (status === 401 || status === 403) {
      await markNeedsUserAction(item.client_event_id, data.error ?? "Sessão expirada. Inicie sessão novamente.");
      return true;
    }
    if (status === 413) {
      await markNeedsUserAction(item.client_event_id, "Foto demasiado grande. Tire outra foto.");
      return true;
    }
    if (!data.signed_url || !data.token || !data.storage_path || !data.bucket) {
      throw new Error(data.error ?? "Resposta inválida ao preparar o envio.");
    }

    // Upload direto ao Supabase Storage via fetch PUT + AbortController (60s).
    // O SDK uploadToSignedUrl não tem timeout nem cancel e trava em mobile.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60_000);
    try {
      const resp = await fetch(data.signed_url, {
        method: "PUT",
        body: item.blob,
        headers: { "Content-Type": item.mimeType || "application/octet-stream" },
        signal: controller.signal,
      });
      clearTimeout(abortTimer);
      if (!resp.ok) throw new Error(`Storage ${resp.status}: ${resp.statusText}`);
    } catch (fetchErr) {
      clearTimeout(abortTimer);
      if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
        throw new Error("Timeout ao enviar foto. Verifica a ligação.");
      }
      throw fetchErr;
    }

    await confirmUpload(item, "uploaded");
    await markUploaded(item.client_event_id);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha de rede";
    if (item.attempts + 1 >= MAX_ATTEMPTS) {
      await markNeedsUserAction(item.client_event_id, "Não conseguimos enviar. Toque para tentar novamente.");
      await confirmUpload(item, "failed", message).catch(() => undefined);
      return true;
    }
    await markFailed(item.client_event_id, message);
    return false;
  }
}

/**
 * Processa toda a fila pendente uma vez. Seguro para chamar em paralelo
 * (guard `running`). Não lança.
 */
export async function processUploadQueue(): Promise<void> {
  if (running || !isOnline()) return;
  running = true;
  try {
    const pending = await getPendingUploads();
    for (const item of pending) {
      if (!isOnline()) break;
      await processItem(item);
    }
  } catch {
    /* nunca lançar a partir do runner */
  } finally {
    running = false;
  }
}

/**
 * Itens presos em "uploading" de uma sessão anterior (app fechou durante upload)
 * nunca seriam retomados porque getPendingUploads só devolve queued/failed.
 * Reseta-os para "queued" sem incrementar tentativas.
 */
async function resetStaleUploading(): Promise<void> {
  try {
    const all = await getAllUploads();
    for (const item of all) {
      if (item.status === "uploading") {
        await updateUpload(item.client_event_id, { status: "queued" });
      }
    }
  } catch { /* ignore */ }
}

let listenersBound = false;

/** Liga o processamento automático: ao voltar a internet e periodicamente. */
export function startUploadQueueWatcher(intervalMs = 30_000): () => void {
  if (typeof window === "undefined") return () => {};

  const tick = () => void processUploadQueue();

  if (!listenersBound) {
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    listenersBound = true;
  }

  // Resetar itens órfãos de sessões anteriores antes de começar a processar.
  void resetStaleUploading().then(tick);
  const id = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(id);
}
