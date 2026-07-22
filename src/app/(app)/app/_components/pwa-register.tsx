"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { initOfflineSync } from "@/lib/offline-sync";
import { hasCriticalActionInFlight } from "@/lib/critical-action-tracker";

export function PwaRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);

  // Sincronização da fila offline de registos de ponto
  useEffect(() => initOfflineSync(), []);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    // Só recarregar por troca de controlador se já havia um controlador antes
    // (evita reload no primeiro registo) e só depois de ativar a atualização
    // (pelo botão OU automaticamente, ver mais abaixo).
    const hadController = !!navigator.serviceWorker.controller;
    let reloadAllowed = false;

    function onControllerChange() {
      if (hadController && reloadAllowed) window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (reg) => {
        // Mostra o aviso só se já houver uma versão ativa (é atualização, não 1ª instalação).
        function trackWaiting(sw: ServiceWorker | null) {
          if (sw && reg.active) setWaiting(sw);
        }

        // Já existe uma versão à espera (atualização pendente de sessão anterior).
        trackWaiting(reg.waiting);

        // Nova versão encontrada → quando ficar "installed", há atualização.
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") trackWaiting(reg.waiting);
          });
        });

        function activate() {
          reloadAllowed = true;
          reg.waiting?.postMessage("SKIP_WAITING");
        }

        // Expor o gatilho de ativação para o botão "Atualizar".
        (window as unknown as { __activateUpdate?: () => void }).__activateUpdate = activate;

        // Verificar atualização ao voltar à app; e aplicá-la sozinha quando a
        // app vai para segundo plano (ecrã bloqueado, troca de app) — momento
        // invisível para quem usa, nunca a meio de um registo de ponto em
        // curso (hasCriticalActionInFlight). O botão "Atualizar" continua a
        // aparecer para quem quiser aplicar de imediato sem esperar por isto.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            reg.update().catch(() => {});
          } else if (reg.waiting && !hasCriticalActionInFlight()) {
            activate();
          }
        });

        // ── Push (best-effort, inalterado) ──────────────────────────────
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
      })
      .catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  function applyUpdate() {
    setReloading(true);
    const activate = (window as unknown as { __activateUpdate?: () => void }).__activateUpdate;
    if (activate) {
      activate();
      // Fallback: se o controllerchange não disparar em 3s, recarregar à mão.
      setTimeout(() => window.location.reload(), 3000);
    } else {
      window.location.reload();
    }
  }

  if (!waiting) return null;

  return (
    <div className="fixed bottom-20 inset-x-3 z-50 flex items-center gap-3 rounded-2xl bg-[var(--color-text-main)] text-white px-4 py-3 shadow-lg">
      <RefreshCw className={`w-4 h-4 shrink-0 ${reloading ? "animate-spin" : ""}`} />
      <span className="text-sm flex-1">Atualização disponível</span>
      <button
        type="button"
        onClick={applyUpdate}
        disabled={reloading}
        className="text-sm font-semibold bg-white text-[var(--color-text-main)] rounded-lg px-3 py-1.5 active:opacity-80 disabled:opacity-60"
      >
        {reloading ? "A atualizar…" : "Atualizar"}
      </button>
    </div>
  );
}
