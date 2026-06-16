"use client";

import { useEffect } from "react";
import { initOfflineSync } from "@/lib/offline-sync";

export function PwaRegister() {
  // Sincronização da fila offline de registos de ponto
  useEffect(() => initOfflineSync(), []);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (reg) => {
        // Quando o SW actualiza, recarrega a página para mostrar conteúdo novo
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.location.reload();
        });

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
          // Silently fail — push is best-effort
        }
      })
      .catch(() => {});
  }, []);

  return null;
}

