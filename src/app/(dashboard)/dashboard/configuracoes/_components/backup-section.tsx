"use client";

import { useState } from "react";
import { CheckCircle, Download, Loader2 } from "lucide-react";

type Status = "idle" | "working" | "done" | "error";

const LAST_BACKUP_KEY = "mo_limpezas_last_backup_at";

function formatBackupDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString("pt-PT", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function BackupSection() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(LAST_BACKUP_KEY),
  );

  async function handleBackup() {
    setStatus("working");
    setError(null);
    try {
      const res = await fetch("/api/dashboard/backups/export");
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? "mo-limpezas-backup.zip";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const now = new Date().toISOString();
      window.localStorage.setItem(LAST_BACKUP_KEY, now);
      window.localStorage.removeItem("mo_limpezas_backup_snoozed_until");
      setLastBackupAt(now);
      setStatus("done");
      setTimeout(() => setStatus("idle"), 4000);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Erro ao gerar backup.");
    }
  }

  const isWorking = status === "working";
  const formatted = formatBackupDate(lastBackupAt);

  return (
    <section id="backup" className="rounded-xl border border-[var(--color-border)] bg-white p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-main)]">Backup dos dados</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-sub)]">
            Gere uma cópia dos dados da empresa em formato ZIP para guardar no computador. Recomendamos fazer este backup semanalmente.
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Último backup realizado em: {formatted ?? "ainda não registado neste navegador"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleBackup}
          disabled={isWorking}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
        >
          {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {isWorking ? "A gerar..." : "Fazer backup agora"}
        </button>
      </div>

      {status === "done" && (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle className="h-3.5 w-3.5" />
          Download iniciado.
        </p>
      )}
      {status === "error" && (
        <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
