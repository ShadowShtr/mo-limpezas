"use client";

import { RefreshCw } from "lucide-react";
import { useServiceWorkerUpdate } from "@/lib/hooks/use-service-worker-update";

/**
 * Aviso de atualização do PWA — versão leve para o dashboard do gestor.
 * Regista o service worker, deteta novas versões e mostra um toast "Atualizar".
 * Não força reload sozinho (só quando o utilizador clica). Sem push/offline
 * (isso fica no app das colaboradoras, ver pwa-register.tsx).
 */
export function SwUpdatePrompt() {
  const { waiting, reloading, apply } = useServiceWorkerUpdate();

  if (!waiting) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-3 rounded-2xl bg-[var(--color-text-main)] text-white px-4 py-3 shadow-lg max-w-[calc(100vw-2rem)]">
      <RefreshCw className={`w-4 h-4 shrink-0 ${reloading ? "animate-spin" : ""}`} />
      <span className="text-sm flex-1">Nova versão disponível</span>
      <button
        type="button"
        onClick={apply}
        disabled={reloading}
        className="text-sm font-semibold bg-white text-[var(--color-text-main)] rounded-lg px-3 py-1.5 active:opacity-80 disabled:opacity-60"
      >
        {reloading ? "A atualizar…" : "Atualizar"}
      </button>
    </div>
  );
}
