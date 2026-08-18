"use client";

// ============================================================================
// ANEXOS — o campo, um só para todo o sistema
// ============================================================================
// Pagamentos, Tarefas e Faltas usam este componente. A alternativa era cada
// página reimplementar múltiplos ficheiros à sua maneira, que é como se chega
// outra vez ao problema que esta ronda resolve.
//
// O que garante, do lado do cliente:
//   · adicionar NUNCA substitui — a lista só cresce até alguém remover;
//   · cada ficheiro sobe por si: 3 seleccionados, 1 falha, 2 ficam;
//   · `clientEventId` estável por ficheiro escolhido, para o retry e o
//     duplo-clique não criarem anexos duplicados;
//   · o anexo legado aparece na mesma lista, marcado, e remove-se por um
//     caminho diferente (ver `source` em AttachmentView).
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { Paperclip, Trash2, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import type { AttachmentView } from "@/lib/attachments";
import { MAX_ATTACHMENTS_PER_PARENT } from "@/lib/attachments";
import { addAttachment, getAttachmentUrl, removeAttachment } from "@/app/actions/attachments";
import { useToast } from "@/components/ui/toast";

interface Props {
  parentType: string;
  parentId: string;
  initialAttachments: AttachmentView[];
  /** Sem permissão, a lista continua visível e legível — só não se altera. */
  canEdit?: boolean;
}

interface PendingUpload {
  key: string;
  name: string;
  error?: string;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsField({ parentType, parentId, initialAttachments, canEdit = true }: Props) {
  const [attachments, setAttachments] = useState<AttachmentView[]>(initialAttachments);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Um id por ficheiro escolhido, não por tentativa: é o que permite ao
  // servidor reconhecer um retry do mesmo ficheiro e devolver o anexo já
  // criado em vez de criar um segundo.
  const eventIdFor = useCallback(
    (file: File, index: number) => `${parentId}:${file.name}:${file.size}:${file.lastModified}:${index}`,
    [parentId],
  );

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files);

    setPending(chosen.map((f, i) => ({ key: eventIdFor(f, i), name: f.name })));

    // Sequencial de propósito: mantém a ordem de criação estável e evita N
    // uploads simultâneos a competir pela mesma ligação.
    for (const [index, file] of chosen.entries()) {
      const key = eventIdFor(file, index);
      const fd = new FormData();
      fd.set("file", file);
      fd.set("clientEventId", key);

      const res = await addAttachment(parentType, parentId, fd);

      if (res.ok) {
        // Um retry devolve o anexo que já existia — não o duplicar na lista.
        setAttachments((prev) =>
          prev.some((a) => a.id === res.attachment.id) ? prev : [...prev, res.attachment],
        );
        setPending((prev) => prev.filter((p) => p.key !== key));
      } else {
        // O ficheiro que falhou fica visível com o erro; os outros seguem.
        setPending((prev) => prev.map((p) => (p.key === key ? { ...p, error: res.error } : p)));
        toast(`${file.name}: ${res.error}`, "error");
      }
    }

    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleOpen(attachment: AttachmentView) {
    const res = await getAttachmentUrl(parentType, parentId, attachment.id);
    if (!res.ok) {
      toast(res.error, "error");
      return;
    }
    window.open(res.url, "_blank", "noopener,noreferrer");
  }

  async function handleRemove(attachment: AttachmentView) {
    setRemoving(attachment.id);
    const res = await removeAttachment(parentType, parentId, attachment.id);
    setRemoving(null);

    if (!res.ok) {
      toast(res.error, "error");
      return;
    }
    // Só o escolhido sai da lista.
    setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
  }

  const atLimit = attachments.filter((a) => a.source === "attachments").length >= MAX_ATTACHMENTS_PER_PARENT;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--color-foreground)]">
          Anexos {attachments.length > 0 && `(${attachments.length})`}
        </span>
      </div>

      {attachments.length === 0 && pending.length === 0 && (
        <p className="text-sm text-[var(--color-muted-foreground)]">Sem anexos.</p>
      )}

      <ul className="space-y-2">
        {attachments.map((a) => (
          <li
            key={a.id}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2"
          >
            <Paperclip className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--color-foreground)]">{a.name}</p>
              {a.sizeBytes != null && (
                <p className="text-xs text-[var(--color-muted-foreground)]">{formatSize(a.sizeBytes)}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => handleOpen(a)}
              className="rounded p-1.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-background)] hover:text-[var(--color-foreground)]"
              title="Abrir"
            >
              <ExternalLink className="h-4 w-4" />
            </button>

            {canEdit && (
              <button
                type="button"
                onClick={() => handleRemove(a)}
                disabled={removing === a.id}
                className="rounded p-1.5 text-[var(--color-muted-foreground)] hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                title="Remover"
              >
                {removing === a.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            )}
          </li>
        ))}

        {pending.map((p) => (
          <li
            key={p.key}
            className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2"
          >
            {p.error ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--color-muted-foreground)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--color-muted-foreground)]">{p.name}</p>
              {p.error && <p className="text-xs text-red-600">{p.error}</p>}
            </div>
            {p.error && (
              <button
                type="button"
                onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                className="rounded p-1.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-background)]"
                title="Dispensar"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={atLimit}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted-foreground)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" />
            {attachments.length === 0 ? "Adicionar ficheiro" : "Adicionar outro"}
          </button>
          {atLimit && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Limite de {MAX_ATTACHMENTS_PER_PARENT} anexos atingido.
            </p>
          )}
        </>
      )}
    </div>
  );
}
