"use client";

import { useState, useTransition, useRef } from "react";
import {
  FileText, File, Download, Loader2, Camera, Receipt,
  ChevronDown, ChevronUp, AlertTriangle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  getDamageReportUploadUrl,
  saveDamageReportRecord,
  getSignedDocumentUrl,
  type CollaboratorDocument,
  type DocumentCategory,
} from "@/app/actions/collaborator-documents";

const BUCKET = "collaborator-documents";

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  recibo_salario: "Folha de Salário",
  contrato:       "Contrato",
  identificacao:  "Identificação",
  avaria:         "Relatório de Avaria",
  outro:          "Documento",
};

const CATEGORY_ICONS: Record<DocumentCategory, typeof FileText> = {
  recibo_salario: Receipt,
  contrato:       FileText,
  identificacao:  FileText,
  avaria:         AlertTriangle,
  outro:          File,
};

const CATEGORY_COLORS: Record<DocumentCategory, string> = {
  recibo_salario: "text-green-600 bg-green-50",
  contrato:       "text-blue-600 bg-blue-50",
  identificacao:  "text-purple-600 bg-purple-50",
  avaria:         "text-red-600 bg-red-50",
  outro:          "text-gray-500 bg-gray-50",
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });
}

function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

interface Props {
  initialDocuments: CollaboratorDocument[];
}

export function AppDocumentsSection({ initialDocuments }: Props) {
  const [docs, setDocs]             = useState<CollaboratorDocument[]>(initialDocuments);
  const [showDamageForm, setShowDamageForm] = useState(false);
  const [notes, setNotes]           = useState("");
  const [uploading, startUpload]    = useTransition();
  const [message, setMessage]       = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [expanded, setExpanded]     = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cache de signed URLs para evitar chamada ao servidor em cada toque
  const urlCache = useRef<Map<string, { url: string; expiresAt: number }>>(new Map());

  const salaryDocs = docs.filter((d) => d.category === "recibo_salario");
  const otherDocs  = docs.filter((d) => d.category !== "recibo_salario");

  async function handleDownload(doc: CollaboratorDocument) {
    if (!doc.file_url) return;

    // Usar URL em cache se ainda válida (50 min — signed URL dura 1h)
    const cached = urlCache.current.get(doc.id);
    if (cached && cached.expiresAt > Date.now()) {
      window.open(cached.url, "_blank", "noopener,noreferrer");
      return;
    }

    setDownloading(doc.id);
    const res = await getSignedDocumentUrl(doc.file_url);
    setDownloading(null);

    if (res.ok) {
      urlCache.current.set(doc.id, { url: res.url, expiresAt: Date.now() + 50 * 60 * 1000 });
      window.open(res.url, "_blank", "noopener,noreferrer");
    } else {
      setMessage({ type: "error", text: "Não foi possível abrir o ficheiro. Tente novamente." });
    }
  }

  async function compressImage(file: File): Promise<File> {
    if (!file.type.startsWith("image/")) return file;
    return new Promise((resolve) => {
      // Timeout de segurança — canvas.toBlob() nunca chama o callback em alguns WebViews
      const bail = setTimeout(() => resolve(file), 8000);

      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { clearTimeout(bail); resolve(file); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            clearTimeout(bail);
            if (!blob) { resolve(file); return; }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resolve(new (File as any)([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }) as File);
          },
          "image/jpeg",
          0.82,
        );
      };
      img.onerror = () => { clearTimeout(bail); URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setMessage(null);
    startUpload(async () => {
      // Timeout global de 60s — garante que uploading nunca fica preso para sempre
      let timedOut = false;
      const globalTimeout = setTimeout(() => {
        timedOut = true;
        setMessage({ type: "error", text: "O envio demorou demasiado. Verifica a ligação e tenta novamente." });
      }, 60_000);

      try {
        // 1. Comprimir imagem no dispositivo (máx 8s, senão usa original)
        const compressed = await compressImage(file);
        if (timedOut) return;

        // 2. Pedir URL assinada ao servidor
        const urlRes = await getDamageReportUploadUrl(compressed.name);
        if (timedOut) return;
        if (!urlRes.ok) {
          setMessage({ type: "error", text: urlRes.error });
          return;
        }

        // 3. Upload directo celular → Supabase via URL assinada
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .uploadToSignedUrl(urlRes.path, urlRes.token, compressed, { contentType: compressed.type });
        if (timedOut) return;
        if (uploadError) {
          setMessage({ type: "error", text: `Erro ao enviar ficheiro: ${uploadError.message}` });
          return;
        }

        // 4. Guardar registo na BD e notificar gestores
        const saveRes = await saveDamageReportRecord({
          path:      urlRes.path,
          publicUrl: urlRes.publicUrl,
          fileName:  compressed.name,
          fileSize:  compressed.size,
          mimeType:  compressed.type,
          notes:     notes || null,
        });
        if (timedOut) return;

        if (saveRes.ok) {
          clearTimeout(globalTimeout);
          setMessage({ type: "success", text: "Relatório enviado. O gestor foi notificado." });
          setNotes("");
          setShowDamageForm(false);
          if (fileRef.current) fileRef.current.value = "";
          setDocs((prev) => [{
            id:                      saveRes.id ?? crypto.randomUUID(),
            file_name:               compressed.name,
            file_url:                urlRes.publicUrl,
            file_size:               compressed.size,
            mime_type:               compressed.type,
            category:                "avaria",
            notes:                   notes || null,
            visible_to_collaborator: true,
            uploaded_by_role:        "colaboradora",
            expires_at:              null,
            archived_at:             null,
            created_at:              new Date().toISOString(),
            uploaded_by_name:        null,
          }, ...prev]);
        } else {
          setMessage({ type: "error", text: saveRes.error ?? "Erro ao guardar. Tenta novamente." });
        }
      } catch (err) {
        if (!timedOut) {
          setMessage({ type: "error", text: err instanceof Error ? err.message : "Erro inesperado. Tenta novamente." });
        }
      } finally {
        clearTimeout(globalTimeout);
      }
    });
  }

  function openFilePicker() {
    // Reset para permitir seleccionar o mesmo ficheiro de novo
    if (fileRef.current) fileRef.current.value = "";
    fileRef.current?.click();
  }

  if (docs.length === 0 && !showDamageForm) {
    return (
      <div
        className="rounded-2xl p-4"
        style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-[var(--color-primary)]" />
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Os meus documentos</p>
        </div>
        <p className="text-sm text-[var(--color-text-muted)] mb-3">
          As suas folhas de salário e documentos aparecerão aqui quando o gestor os carregar.
        </p>
        <button
          type="button"
          onClick={() => setShowDamageForm(true)}
          className="flex items-center gap-2 w-full justify-center py-2.5 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 active:bg-red-100 transition-colors"
        >
          <Camera className="w-4 h-4" />
          Reportar avaria / dano
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}
    >
      {/* Header colapsável */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 p-4 hover:bg-white/30 transition-colors"
      >
        <FileText className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
        <p className="text-sm font-semibold text-[var(--color-text-main)] flex-1 text-left">Os meus documentos</p>
        <span className="text-xs bg-[var(--color-primary-light)] text-[var(--color-primary)] px-1.5 py-0.5 rounded-full font-medium mr-1">
          {docs.length}
        </span>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-[var(--color-text-muted)]" />
          : <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />}
      </button>

      {expanded && (
        <div className="border-t border-[var(--glass-border)]">

          {/* Folhas de salário */}
          {salaryDocs.length > 0 && (
            <div className="p-4 space-y-2">
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
                Folhas de Salário
              </p>
              {salaryDocs.map((doc) => {
                const days          = daysUntil(doc.expires_at);
                const isDownloading = downloading === doc.id;
                const isCached      = urlCache.current.has(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => handleDownload(doc)}
                    disabled={isDownloading || !doc.file_url}
                    className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/50 hover:bg-white/80 active:bg-white/80 transition-colors group disabled:opacity-60 disabled:cursor-not-allowed text-left"
                  >
                    <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                      <Receipt className="w-4 h-4 text-green-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
                        {doc.notes || doc.file_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {fmtDate(doc.created_at)}{doc.file_size ? ` · ${fmtSize(doc.file_size)}` : ""}
                      </p>
                      {days !== null && days < 14 && days > 0 && (
                        <p className="text-[10px] text-amber-600 font-medium">Expira em {days} dias</p>
                      )}
                      {!doc.file_url && (
                        <p className="text-[10px] text-[var(--color-text-muted)]">A processar…</p>
                      )}
                    </div>
                    {isDownloading
                      ? <Loader2 className="w-4 h-4 text-[var(--color-primary)] animate-spin shrink-0" />
                      : <Download className={`w-4 h-4 shrink-0 transition-colors ${isCached ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)]"}`} />
                    }
                  </button>
                );
              })}
            </div>
          )}

          {/* Outros documentos */}
          {otherDocs.length > 0 && (
            <div className={`p-4 space-y-2 ${salaryDocs.length > 0 ? "border-t border-[var(--glass-border)]" : ""}`}>
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
                Outros documentos
              </p>
              {otherDocs.map((doc) => {
                const CatIcon       = CATEGORY_ICONS[doc.category];
                const colorClass    = CATEGORY_COLORS[doc.category];
                const isDownloading = downloading === doc.id;
                const isCached      = urlCache.current.has(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => handleDownload(doc)}
                    disabled={isDownloading || !doc.file_url}
                    className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/50 hover:bg-white/80 active:bg-white/80 transition-colors group disabled:opacity-60 disabled:cursor-not-allowed text-left"
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                      <CatIcon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
                        {doc.notes || doc.file_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {CATEGORY_LABELS[doc.category]} · {fmtDate(doc.created_at)}
                      </p>
                      {!doc.file_url && (
                        <p className="text-[10px] text-[var(--color-text-muted)]">A processar…</p>
                      )}
                    </div>
                    {doc.file_url && (
                      isDownloading
                        ? <Loader2 className="w-4 h-4 text-[var(--color-primary)] animate-spin shrink-0" />
                        : <Download className={`w-4 h-4 shrink-0 transition-colors ${isCached ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)]"}`} />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Formulário de avaria */}
          {showDamageForm ? (
            <div className="p-4 border-t border-[var(--glass-border)] space-y-3">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Reportar avaria / dano</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Tire uma foto ou escolha um ficheiro da galeria. O gestor será notificado.
              </p>

              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Descreva o que aconteceu (opcional)"
                className="w-full text-sm border border-[var(--color-border)] rounded-xl px-3 py-2 bg-white/70 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
              />

              {/* Sem capture= para mostrar o picker nativo (câmara + galeria) instantaneamente */}
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={handleFileChange}
                disabled={uploading}
              />

              <button
                type="button"
                onClick={openFilePicker}
                disabled={uploading}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-red-500 text-white text-sm font-semibold active:opacity-80 disabled:opacity-50 transition-opacity"
              >
                {uploading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> A enviar...</>
                  : <><Camera className="w-4 h-4" /> Tirar foto ou escolher ficheiro</>
                }
              </button>

              <button
                type="button"
                onClick={() => { setShowDamageForm(false); setMessage(null); }}
                className="w-full py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] bg-white/50 active:bg-white/80"
              >
                Cancelar
              </button>

              {message && (
                <p className={`text-xs px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>
                  {message.text}
                </p>
              )}
            </div>
          ) : (
            <div className="p-4 border-t border-[var(--glass-border)]">
              <button
                type="button"
                onClick={() => { setShowDamageForm(true); setMessage(null); }}
                className="flex items-center gap-2 w-full justify-center py-2.5 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 active:bg-red-100 transition-colors"
              >
                <Camera className="w-4 h-4" />
                Reportar avaria / dano
              </button>
              {message?.type === "success" && (
                <p className="text-xs text-center text-green-600 mt-2">{message.text}</p>
              )}
              {message?.type === "error" && (
                <p className="text-xs text-center text-red-600 mt-2">{message.text}</p>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
