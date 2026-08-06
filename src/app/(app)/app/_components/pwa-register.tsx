"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { initOfflineSync } from "@/lib/offline-sync";
import { hasCriticalActionInFlight } from "@/lib/critical-action-tracker";
import { useServiceWorkerUpdate } from "@/lib/hooks/use-service-worker-update";

export function PwaRegister() {
  // Sincronização da fila offline de registos de ponto
  useEffect(() => initOfflineSync(), []);

  const { waiting, reloading, apply } = useServiceWorkerUpdate({
    // Aplica sozinho quando a app vai para segundo plano (ecrã bloqueado,
    // troca de app) — momento invisível para quem usa, nunca a meio de um
    // registo de ponto em curso. O botão "Atualizar" continua a aparecer
    // para quem quiser aplicar de imediato sem esperar por isto.
    autoApplyInBackground: true,
    isSafeToAutoApply: () => !hasCriticalActionInFlight(),
    onRegistered: (reg) => {
      void registerPush(reg);
    },
  });

  if (!waiting) return null;

  return (
    <div className="fixed bottom-20 inset-x-3 z-50 flex items-center gap-3 rounded-2xl bg-[var(--color-text-main)] text-white px-4 py-3 shadow-lg">
      <RefreshCw className={`w-4 h-4 shrink-0 ${reloading ? "animate-spin" : ""}`} />
      <span className="text-sm flex-1">Atualização disponível</span>
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

// Push (best-effort, inalterado) — extraído para função à parte para não
// misturar a lógica de subscrição com a de atualização do service worker.
async function registerPush(reg: ServiceWorkerRegistration) {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey || !("PushManager" in window)) return;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
    }
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
  } catch {
    /* Silently fail — push is best-effort */
  }
}
