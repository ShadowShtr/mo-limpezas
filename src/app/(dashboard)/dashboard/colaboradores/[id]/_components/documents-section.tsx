"use client";

import { useState, useRef, useTransition } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Upload, Trash2, Download, FileText, FileImage, File, X, Loader2 } from "lucide-react";
import {
  uploadCollaboratorDocument,
  deleteCollaboratorDocument,
  getSignedDocumentUrl,
  type CollaboratorDocument,
} from "@/app/actions/collaborator-documents";

const CATEGORIES = [
  { value: "contrato",        label: "Contrato" },
  { value: "recibo_salario",  label: "Recibo de Salário" },
  { value: "identificacao",   label: "Identificação" },
  { value: "outro",           label: "Outro" },
] as const;

function categoryLabel(cat: CollaboratorDocument["category"]) {
  return CATEGORIES.find((c) => c.value === cat)?.label ?? cat;
}

function fileIcon(mime: string | null) {
  if (!mime) return <File className="w-4 h-4" />;
  if (mime.startsWith("image/")) return <FileImage className="w-4 h-4 text-blue-500" />;
  if (mime === "application/pdf") return <FileText className="w-4 h-4 text-red-500" />;
  return <File className="w-4 h-4 text-gray-400" />;
}

function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  collaboratorId: string;
  companyId: string;
  initialDocuments: CollaboratorDocument[];
}

export function DocumentsSection({ collaboratorId, companyId, initialDocuments }: Props) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [uploading, startUpload] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>("outro");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setSelectedFile(f);
    setUploadError(null);
  }

  function handleUpload() {
    if (!selectedFile) return;
    setUploadError(null);
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("category", category);
    startUpload(async () => {
      const res = await uploadCollaboratorDocument(collaboratorId, companyId, fd);
      if (!res.ok) {
        setUploadError(res.error);
        return;
      }
      // Optimistic: reload via server revalidation happens on next navigation
      // For immediate feedback, add a placeholder
      const placeholder: CollaboratorDocument = {
        id: res.id,
        file_name: selectedFile.name,
        file_url: "",
        file_size: selectedFile.size,
        mime_type: selectedFile.type,
        category: category as CollaboratorDocument["category"],
        created_at: new Date().toISOString(),
        uploaded_by_name: null,
      };
      setDocuments((prev) => [placeholder, ...prev]);
      setShowModal(false);
      setSelectedFile(null);
      setCategory("outro");
      if (fileInputRef.current) fileInputRef.current.value = "";
    });
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    const res = await deleteCollaboratorDocument(id, collaboratorId);
    if (res.ok) {
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    }
    setDeleting(null);
  }

  async function handleDownload(doc: CollaboratorDocument) {
    const res = await getSignedDocumentUrl(doc.file_url);
    const url = res.ok ? res.url : doc.file_url;
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.file_name;
    a.target = "_blank";
    a.click();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Paperclip className="w-4 h-4 text-[var(--color-primary)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Documentos</h3>
          {documents.length > 0 && (
            <span className="text-xs bg-[var(--color-primary-light)] text-[var(--color-primary)] px-1.5 py-0.5 rounded-full font-medium">
              {documents.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white font-medium hover:opacity-90 transition-opacity"
        >
          <Upload className="w-3.5 h-3.5" />
          Carregar
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="py-10 text-center">
          <Paperclip className="w-8 h-8 text-[var(--color-text-muted)] mx-auto mb-2 opacity-40" />
          <p className="text-sm text-[var(--color-text-muted)]">Nenhum documento carregado.</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {documents.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--color-background)] transition-colors">
              <div className="shrink-0">{fileIcon(doc.mime_type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--color-text-main)] truncate">{doc.file_name}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {categoryLabel(doc.category)}
                  {doc.file_size ? ` · ${fmtSize(doc.file_size)}` : ""}
                  {doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => handleDownload(doc)}
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-primary)] transition-colors"
                  title="Descarregar"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(doc.id)}
                  disabled={deleting === doc.id}
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-40"
                  title="Eliminar"
                >
                  {deleting === doc.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Upload modal */}
      {showModal && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Carregar documento</h2>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-[var(--color-background)]">
                <X className="w-4 h-4 text-[var(--color-text-muted)]" />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Ficheiro</label>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileChange}
                className="block w-full text-sm text-[var(--color-text-sub)] file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[var(--color-primary-light)] file:text-[var(--color-primary)] hover:file:opacity-80 border border-[var(--color-border)] rounded-lg p-1"
              />
              {selectedFile && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">{fmtSize(selectedFile.size)}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            {uploadError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{uploadError}</p>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpload}
                disabled={!selectedFile || uploading}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Carregar
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
