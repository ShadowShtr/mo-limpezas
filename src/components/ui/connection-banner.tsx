"use client";

import { useEffect, useRef, useState } from "react";
import { WifiOff, CloudOff } from "lucide-react";

type Status = "online" | "offline" | "slow";

const CHECK_URL = "/api/health";
const PROBE_TIMEOUT_MS = 5000;
const SLOW_THRESHOLD_MS = 4000;
const INTERVAL_MS = 30_000;

export function ConnectionBanner() {
  const [status, setStatus] = useState<Status>("online");
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    async function checkLatency() {
      if (inFlightRef.current) return; // nunca acumular pedidos
      if (!navigator.onLine) { setStatus("offline"); return; }

      inFlightRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      const start = Date.now();
      try {
        const res = await fetch(CHECK_URL, { method: "HEAD", cache: "no-store", signal: controller.signal });
        const ms = Date.now() - start;
        setStatus(!res.ok || ms > SLOW_THRESHOLD_MS ? "slow" : "online");
      } catch {
        // Timeout (AbortError) ou falha de rede
        setStatus(navigator.onLine ? "slow" : "offline");
      } finally {
        clearTimeout(timeoutId);
        inFlightRef.current = false;
        abortRef.current = null;
      }
    }

    function handleOffline() { abortRef.current?.abort(); setStatus("offline"); }
    function handleOnline()  { void checkLatency(); }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    const timer = setInterval(checkLatency, INTERVAL_MS);
    void checkLatency();

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  if (status === "online") return null;

  return (
    <div
      role="alert"
      className={`flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium z-50 ${
        status === "offline" ? "bg-red-600 text-white" : "bg-amber-500 text-white"
      }`}
    >
      {status === "offline" ? (
        <><WifiOff className="w-3.5 h-3.5 shrink-0" />Sem ligação — os pontos serão guardados e enviados quando a rede voltar.</>
      ) : (
        <><CloudOff className="w-3.5 h-3.5 shrink-0" />Ligação lenta — algumas operações podem demorar mais do habitual.</>
      )}
    </div>
  );
}
