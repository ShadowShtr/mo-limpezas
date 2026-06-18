"use client";

import { useEffect, useState } from "react";
import { WifiOff, CloudOff } from "lucide-react";

type Status = "online" | "offline" | "slow";

const CHECK_URL = "/api/health";
const SLOW_THRESHOLD_MS = 4000;

export function ConnectionBanner() {
  const [status, setStatus] = useState<Status>("online");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    function handleOffline() { setStatus("offline"); }
    function handleOnline() { checkLatency(); }

    async function checkLatency() {
      if (!navigator.onLine) { setStatus("offline"); return; }
      const start = Date.now();
      try {
        const res = await fetch(CHECK_URL, { method: "HEAD", cache: "no-store" });
        const ms = Date.now() - start;
        if (!res.ok) { setStatus("slow"); }
        else if (ms > SLOW_THRESHOLD_MS) { setStatus("slow"); }
        else { setStatus("online"); }
      } catch {
        setStatus("slow");
      }
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    // Verificar a cada 30s
    timer = setInterval(checkLatency, 30_000);
    checkLatency();

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      clearInterval(timer);
    };
  }, []);

  if (status === "online") return null;

  return (
    <div
      role="alert"
      className={`
        flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium z-50
        ${status === "offline"
          ? "bg-red-600 text-white"
          : "bg-amber-500 text-white"}
      `}
    >
      {status === "offline" ? (
        <>
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          Sem ligação — os pontos serão guardados e enviados quando a rede voltar.
        </>
      ) : (
        <>
          <CloudOff className="w-3.5 h-3.5 shrink-0" />
          Ligação lenta — algumas operações podem demorar mais do habitual.
        </>
      )}
    </div>
  );
}
