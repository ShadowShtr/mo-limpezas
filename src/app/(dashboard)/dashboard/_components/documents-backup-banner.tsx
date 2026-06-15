"use client";

import { useState } from "react";
import { AlertTriangle, Download, Loader2, CheckCircle } from "lucide-react";
import { getDocumentsForBackup } from "@/app/actions/collaborator-documents";

const CATEGORY_FOLDERS: Record<string, string> = {
  recibo_salario: "Folhas de Salario",
  contrato:       "Contratos",
  identificacao:  "Identificacao",
  avaria:         "Relatorios de Avaria",
  outro:          "Outros",
};

type Status = "idle" | "fetching" | "downloading" | "zipping" | "done" | "error";

interface Props {
  expiringCount: number;
}

export function DocumentsBackupBanner({ expiringCount }: Props) {
  const [status, setStatus]   = useState<Status>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (expiringCount === 0) return null;

  async function handleBackup() {
    setStatus("fetching");
    setErrorMsg(null);

    const res = await getDocumentsForBackup();
    if (!res.ok || !res.documents) {
      setStatus("error");
      setErrorMsg(res.error ?? "Erro ao obter documentos");
      return;
    }

    const docs = res.documents.filter((d) => d.signed_url);
    if (docs.length === 0) {
      setStatus("idle");
      return;
    }

    setStatus("downloading");
    setProgress({ current: 0, total: docs.length });

    // Importação dinâmica — não entra no bundle inicial
    const JSZip = (await import("jszip")).default;
    const zip   = new JSZip();

    const usedPaths = new Set<string>();

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      try {
        const response = await fetch(doc.signed_url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();

        // Pasta da colaboradora — sanitizar nome
        const collabFolder = doc.collaborator_name
          .normalize("NFD").replace(/[̀-ͯ]/g, "")
          .replace(/[^\w ]/g, "").trim().replace(/ +/g, "_") || "Colaboradora";

        const catFolder = CATEGORY_FOLDERS[doc.category] ?? "Outros";

        // Evitar colisões de nome no mesmo caminho
        let fileName = doc.file_name;
        let path     = `${collabFolder}/${catFolder}/${fileName}`;
        let counter  = 1;
        while (usedPaths.has(path)) {
          const dot  = fileName.lastIndexOf(".");
          const base = dot > 0 ? fileName.slice(0, dot) : fileName;
          const ext  = dot > 0 ? fileName.slice(dot) : "";
          fileName   = `${base}_${counter}${ext}`;
          path       = `${collabFolder}/${catFolder}/${fileName}`;
          counter++;
        }
        usedPaths.add(path);

        zip.file(path, buffer);
      } catch {
        // ficheiro falhou — continua com o resto
      }
      setProgress({ current: i + 1, total: docs.length });
    }

    setStatus("zipping");

    const zipBlob = await zip.generateAsync({
      type:        "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const companySlug = (res.company_name ?? "Empresa")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^\w ]/g, "").trim().replace(/ +/g, "_");
    const date = new Date().toISOString().slice(0, 10);
    const url  = URL.createObjectURL(zipBlob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `Backup_${companySlug}_${date}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus("done");
    setTimeout(() => setStatus("idle"), 4000);
  }

  const isWorking = status === "fetching" || status === "downloading" || status === "zipping";

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 space-y-3">
      {/* Cabeçalho */}
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">
            {expiringCount === 1
              ? "1 documento expira em menos de 30 dias"
              : `${expiringCount} documentos expiram em menos de 30 dias`}
          </p>
          <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">
            O sistema apaga os ficheiros automaticamente ao fim de 3 meses de forma{" "}
            <strong>irreversível</strong>. Faça um backup completo de todos os documentos
            das colaboradoras antes da data de expiração.
          </p>
        </div>
      </div>

      {/* Barra de progresso */}
      {status === "downloading" && progress.total > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-amber-700">
            <span>A descarregar ficheiros…</span>
            <span>{progress.current} / {progress.total}</span>
          </div>
          <div className="w-full bg-amber-200 rounded-full h-1.5">
            <div
              className="bg-amber-500 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {status === "zipping" && (
        <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          A criar o ficheiro ZIP…
        </p>
      )}

      {status === "fetching" && (
        <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          A preparar o backup…
        </p>
      )}

      {status === "done" && (
        <p className="text-[11px] text-green-700 flex items-center gap-1.5">
          <CheckCircle className="w-3 h-3" />
          Download iniciado com sucesso!
        </p>
      )}

      {status === "error" && errorMsg && (
        <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {errorMsg}
        </p>
      )}

      {/* Botão */}
      <button
        onClick={handleBackup}
        disabled={isWorking}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isWorking ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        {isWorking ? "A processar…" : "Fazer Backup ZIP"}
      </button>

      <p className="text-[10px] text-amber-600">
        O ZIP inclui <strong>todos</strong> os documentos actuais de todas as colaboradoras,
        organizados em pastas por nome e categoria.
      </p>
    </div>
  );
}
