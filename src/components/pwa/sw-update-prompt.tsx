"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Aviso de atualização do PWA — versão leve para o dashboard do gestor.
 * Regista o service worker, deteta novas versões e mostra um toast "Atualizar".
 * Não força reload sozinho (só quando o utilizador clica). Sem push/offline
 * (isso fica no app das colaboradoras).
 */
export function SwUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;
    let userTriggered = false;

    function onControllerChange() {
      if (hadController && userTriggered) window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let cleanupVisibility: (() => void) | undefined;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        const track = (sw: ServiceWorker | null) => { if (sw && reg.active) setWaiting(sw); };
        track(reg.waiting);

        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") track(reg.waiting);
          });
        });

        (window as unknown as { __activateUpdate?: () => void }).__activateUpdate = () => {
          userTriggered = true;
          reg.waiting?.postMessage("SKIP_WAITING");
        };

        const onVisible = () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        };
        document.addEventListener("visibilitychange", onVisible);
        cleanupVisibility = () => document.removeEventListener("visibilitychange", onVisible);
      })
      .catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      cleanupVisibility?.();
    };
  }, []);

  function applyUpdate() {
    setReloading(true);
    const activate = (window as unknown as { __activateUpdate?: () => void }).__activateUpdate;
    if (activate) {
      activate();
      setTimeout(() => window.location.reload(), 3000); // fallback se controllerchange não disparar
    } else {
      window.location.reload();
    }
  }

  if (!waiting) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-3 rounded-2xl bg-[var(--color-text-main)] text-white px-4 py-3 shadow-lg max-w-[calc(100vw-2rem)]">
      <RefreshCw className={`w-4 h-4 shrink-0 ${reloading ? "animate-spin" : ""}`} />
      <span className="text-sm flex-1">Nova versão disponível</span>
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
