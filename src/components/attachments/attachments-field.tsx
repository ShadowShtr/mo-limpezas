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

import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Trash2, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import type { AttachmentView } from "@/lib/attachments";
import { MAX_ATTACHMENTS_PER_PARENT } from "@/lib/attachments";
import { addAttachment, getAttachmentUrl, listAttachments, removeAttachment } from "@/app/actions/attachments";
import { useToast } from "@/components/ui/toast";

interface Props {
  parentType: string;
  parentId: string;
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

export function AttachmentsField({ parentType, parentId, canEdit = true }: Props) {
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // 🔴 O campo é dono da própria leitura.
  //
  // Antes, os três pais faziam `setAttachments([])` + `listAttachments()` e
  // passavam o resultado por prop. Como o estado interno saía de
  // `useState(initialAttachments)`, e `useState` só lê o valor inicial na
  // montagem, a lista que chegava depois nunca aparecia: o anexo existia na
  // base e no bucket, e o utilizador via um registo vazio.
  //
  // Centralizar aqui elimina a classe inteira — não há prop para dessincronizar,
  // e os três fluxos passam a ter exactamente o mesmo comportamento de leitura.
  useEffect(() => {
    // `cancelado` impede que uma resposta atrasada escreva no registo errado:
    // abrir A, saltar para B e receber a resposta de A depois mostraria os
    // anexos de A dentro de B.
    let cancelado = false;

    async function carregar() {
      const res = await listAttachments(parentType, parentId);
      if (cancelado) return;

      if (res.ok) {
        setAttachments(res.attachments);
        setLoadError(null);
      } else {
        // Falhar a ler não é o mesmo que não haver nada. Sem isto, um erro de
        // leitura apareceria como «Sem anexos» — a afirmação oposta à verdade.
        setAttachments([]);
        setLoadError(res.error);
      }
      setLoading(false);
    }

    carregar();
    return () => { cancelado = true; };
  }, [parentType, parentId]);

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

      {/* 🔴 «Sem anexos» é uma afirmação sobre a base, e só se faz depois de a
          ler. Enquanto carrega diz-se que está a carregar; se a leitura falhar
          diz-se o erro. Afirmar ausência sem ter verificado foi metade da
          confusão do relato «o anexo desapareceu». */}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          A carregar anexos…
        </p>
      )}

      {!loading && loadError && (
        <p className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {loadError}
        </p>
      )}

      {!loading && !loadError && attachments.length === 0 && pending.length === 0 && (
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
