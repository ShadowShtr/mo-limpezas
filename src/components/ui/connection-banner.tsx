"use client";

import { useEffect, useRef, useState } from "react";
import { WifiOff, CloudOff } from "lucide-react";

type Status = "online" | "offline" | "slow";

const CHECK_URL = "/api/health";
const PROBE_TIMEOUT_MS = 5000;
const SLOW_THRESHOLD_MS = 4000;

interface Props {
  /**
   * Intervalo entre health checks (ms). TASK 06:
   * colaboradora 3–5 min, gestora 1–2 min. Default 2 min.
   */
  intervalMs?: number;
}

export function ConnectionBanner({ intervalMs = 120_000 }: Props) {
  const [status, setStatus] = useState<Status>("online");
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    async function checkLatency() {
      if (inFlightRef.current) return; // nunca acumular pedidos
      // Não sondar com a aba escondida: poupa bateria e consumo Vercel (TASK 06).
      if (document.hidden) return;
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

    function startTimer() {
      if (timer) return;
      timer = setInterval(checkLatency, intervalMs);
    }
    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    function handleOffline() { abortRef.current?.abort(); setStatus("offline"); }
    function handleOnline()  { void checkLatency(); }
    function handleVisibility() {
      if (document.hidden) {
        // Pausar quando a aba está escondida; abortar sonda em curso.
        stopTimer();
        abortRef.current?.abort();
      } else {
        // Ao voltar à aba, verificar de imediato e retomar o ciclo.
        void checkLatency();
        startTimer();
      }
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    void checkLatency();
    startTimer();

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      stopTimer();
      abortRef.current?.abort();
    };
  }, [intervalMs]);

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
