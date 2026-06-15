"use client";

import { useState, useRef, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  Paperclip, Upload, Trash2, Download, FileText, FileImage,
  File, X, Loader2, Eye, EyeOff, AlertTriangle,
} from "lucide-react";
import {
  uploadCollaboratorDocument,
  deleteCollaboratorDocument,
  getSignedDocumentUrl,
  type CollaboratorDocument,
  type DocumentCategory,
} from "@/app/actions/collaborator-documents";

const CATEGORIES: { value: DocumentCategory; label: string }[] = [
  { value: "recibo_salario", label: "Folha de Salário" },
  { value: "contrato",       label: "Contrato" },
  { value: "identificacao",  label: "Identificação" },
  { value: "avaria",         label: "Relatório de Avaria" },
  { value: "outro",          label: "Outro" },
];

const CATEGORY_COLORS: Record<DocumentCategory, string> = {
  recibo_salario: "bg-green-50 text-green-700",
  contrato:       "bg-blue-50 text-blue-700",
  identificacao:  "bg-purple-50 text-purple-700",
  avaria:         "bg-red-50 text-red-700",
  outro:          "bg-gray-50 text-gray-600",
};

function categoryLabel(cat: DocumentCategory) {
  return CATEGORIES.find((c) => c.value === cat)?.label ?? cat;
}

function fileIcon(mime: string | null) {
  if (!mime) return <File className="w-4 h-4 text-gray-400" />;
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

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 && diff < 14 * 24 * 60 * 60 * 1000;
}

function isBackupWarning(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 && diff < 30 * 24 * 60 * 60 * 1000;
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
  const [category, setCategory] = useState<DocumentCategory>("recibo_salario");
  const [notes, setNotes] = useState("");
  const [visible, setVisible] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const expiringSoon = documents.filter((d) => isExpiringSoon(d.expires_at));
  const backupWarningDocs = documents.filter((d) => isBackupWarning(d.expires_at));

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
    fd.append("notes", notes);
    fd.append("visible_to_collaborator", String(visible));

    startUpload(async () => {
      const res = await uploadCollaboratorDocument(collaboratorId, companyId, fd);
      if (!res.ok) {
        setUploadError(res.error);
        return;
      }
      const placeholder: CollaboratorDocument = {
        id: res.id,
        file_name: selectedFile.name,
        file_url: "",
        file_size: selectedFile.size,
        mime_type: selectedFile.type,
        category,
        notes: notes || null,
        visible_to_collaborator: visible,
        uploaded_by_role: "gestor",
        expires_at: null,
        archived_at: null,
        created_at: new Date().toISOString(),
        uploaded_by_name: null,
      };
      setDocuments((prev) => [placeholder, ...prev]);
      setShowModal(false);
      setSelectedFile(null);
      setNotes("");
      setCategory("recibo_salario");
      if (fileInputRef.current) fileInputRef.current.value = "";
    });
  }

  async function handleDelete(id: string) {
    if (!confirm("Apagar este documento permanentemente?")) return;
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
    <div
      className="rounded-xl overflow-hidden bg-white border border-slate-200/80"
      style={{ boxShadow: "0 1px 3px rgba(15,23,42,0.06), 0 4px 16px rgba(15,23,42,0.04)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--glass-border)]">
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

      {/* Aviso de backup — perda irreversível de dados */}
      {backupWarningDocs.length > 0 && (
        <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <p className="text-sm font-semibold text-amber-800">
              Faça backup — dados serão eliminados permanentemente
            </p>
          </div>
          <p className="text-xs text-amber-700 leading-relaxed">
            {backupWarningDocs.length === 1
              ? "1 documento expira"
              : `${backupWarningDocs.length} documentos expiram`}{" "}
            nos próximos 30 dias e {backupWarningDocs.length === 1 ? "será apagado" : "serão apagados"} automaticamente pelo sistema de forma{" "}
            <strong>irreversível</strong>. Faça download dos ficheiros antes da data de expiração — esta ação não pode ser desfeita e os dados não poderão ser recuperados.
          </p>
        </div>
      )}

      {/* Lista */}
      {documents.length === 0 ? (
        <div className="py-10 text-center">
          <Paperclip className="w-8 h-8 text-[var(--color-text-muted)] mx-auto mb-2 opacity-40" />
          <p className="text-sm text-[var(--color-text-muted)]">Nenhum documento carregado.</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 opacity-60">
            Folhas de salário, contratos e relatórios de avaria aparecem aqui.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--glass-border)]">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className={`flex items-center gap-3 px-5 py-3 hover:bg-white/40 transition-colors group ${
                isExpiringSoon(doc.expires_at) ? "bg-amber-50/30" : ""
              }`}
            >
              <div className="shrink-0">{fileIcon(doc.mime_type)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-[var(--color-text-main)] truncate max-w-[180px]">
                    {doc.notes || doc.file_name}
                  </p>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[doc.category]}`}>
                    {categoryLabel(doc.category)}
                  </span>
                  <span title={doc.visible_to_collaborator ? "Visível à funcionária" : "Apenas gestores"}>
                    {doc.visible_to_collaborator ? (
                      <Eye className="w-3 h-3 text-[var(--color-primary)]" />
                    ) : (
                      <EyeOff className="w-3 h-3 text-[var(--color-text-muted)]" />
                    )}
                  </span>
                  {doc.uploaded_by_role === "colaboradora" && (
                    <span className="text-[10px] bg-amber-50 text-amber-600 px-1 py-0.5 rounded font-medium">
                      Funcionária
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  {fmtDate(doc.created_at)}
                  {doc.file_size ? ` · ${fmtSize(doc.file_size)}` : ""}
                  {doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ""}
                  {doc.expires_at ? ` · Expira ${fmtDate(doc.expires_at)}` : ""}
                </p>
                {isExpiringSoon(doc.expires_at) && (
                  <p className="text-[10px] text-amber-600 font-medium">
                    Arquivamento automático em breve
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={() => handleDownload(doc)}
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-primary)] transition-colors"
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
          <div className="relative rounded-2xl w-full max-w-md p-6 space-y-4 glass-strong">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Carregar documento</h2>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-white/50">
                <X className="w-4 h-4 text-[var(--color-text-muted)]" />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Ficheiro (PDF ou imagem, máx 50 MB)</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                className="block w-full text-sm text-[var(--color-text-sub)] file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[var(--color-primary-light)] file:text-[var(--color-primary)] hover:file:opacity-80 border border-[var(--color-border)] rounded-lg p-1 bg-white/70"
              />
              {selectedFile && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">{fmtSize(selectedFile.size)}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Categoria</label>
              <select
                value={category}
                onChange={(e) => {
                  const c = e.target.value as DocumentCategory;
                  setCategory(c);
                  if (c === "recibo_salario") setVisible(true);
                }}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] bg-white/70"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Notas (opcional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ex: Folha de salário – abril 2026"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] bg-white/70"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-[var(--color-text-sub)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => setVisible(e.target.checked)}
                className="accent-[var(--color-primary)] w-4 h-4"
              />
              Visível à funcionária no app
            </label>

            <p className="text-[11px] text-[var(--color-text-muted)] bg-white/50 rounded-lg px-3 py-2">
              O documento será automaticamente arquivado e apagado após {3} meses.
            </p>

            {uploadError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{uploadError}</p>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-white/50"
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
