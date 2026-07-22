"use client";

import { useState } from "react";
import { LogIn, LogOut, MapPin, AlertTriangle, Loader2, CheckCircle, CloudOff, MapPinOff } from "lucide-react";
import { queueTimesheet } from "@/lib/offline-sync";
import { useSingleFlight } from "@/lib/hooks/use-single-flight";
import { beginCriticalAction, endCriticalAction } from "@/lib/critical-action-tracker";

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Timesheet {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  location_warning: boolean;
  clock_in_distance_m: number | null;
}

interface Props {
  serviceId: string;
  initialTimesheet: Timesheet | null;
}

function isOffline() {
  return typeof navigator !== "undefined" && !navigator.onLine;
}

/** Tenta posição rápida (baixa precisão) e depois alta precisão se necessário. */
async function getPosition(): Promise<GeolocationPosition> {
  if (!navigator.geolocation) throw new Error("GPS não disponível");

  function tryGet(highAccuracy: boolean, timeout: number): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: highAccuracy,
        timeout,
        maximumAge: 0,
      })
    );
  }

  // Passo 1: leitura rápida (económica em bateria, ≤ 3 s)
  try {
    const quick = await tryGet(false, 3000);
    if (quick.coords.accuracy <= 100) return quick; // boa o suficiente
    // Passo 2: alta precisão se leitura rápida foi imprecisa
    return await tryGet(true, 12000);
  } catch {
    // Leitura rápida falhou (negada ou timeout) — tentar alta precisão
    return tryGet(true, 12000);
  }
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export function ClockButton({ serviceId, initialTimesheet }: Props) {
  const [timesheet, setTimesheet] = useState<Timesheet | null>(initialTimesheet);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distanceWarning, setDistanceWarning] = useState<number | null>(null);
  const [queued, setQueued] = useState<"in" | "out" | null>(null);
  // Fallback manual: ativado quando GPS é negado/indisponível
  const [needsManual, setNeedsManual] = useState<"in" | "out" | null>(null);
  // Guarda síncrona contra duplo clique (TASK 24) — fecha a micro-janela do `loading`.
  const singleFlight = useSingleFlight(1500);

  async function getCoords(): Promise<{
    lat: number | null; lng: number | null;
    accuracy: number | null; gpsError?: boolean
  }> {
    try {
      const pos = await getPosition();
      const accuracy = Math.round(pos.coords.accuracy);
      // Leituras com accuracy > 150m são inúteis para validar presença
      if (accuracy > 150) {
        return { lat: null, lng: null, accuracy, gpsError: true };
      }
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy };
    } catch {
      return { lat: null, lng: null, accuracy: null, gpsError: true };
    }
  }

  async function doClockIn(manual = false) {
    setLoading(true);
    beginCriticalAction();
    setError(null);
    setDistanceWarning(null);
    setNeedsManual(null);

    const coords = await getCoords();

    if (coords.gpsError && !manual) {
      setNeedsManual("in");
      setLoading(false);
      endCriticalAction();
      return;
    }

    const { lat, lng, accuracy } = coords;
    const at = new Date().toISOString();
    const client_event_id = uuid();

    if (isOffline()) {
      try {
        await queueTimesheet({ kind: "in", service_id: serviceId, lat, lng, at, manual, gps_accuracy: accuracy, client_event_id });
        setTimesheet({ id: `local-${Date.now()}`, clock_in_at: at, clock_out_at: null, location_warning: manual, clock_in_distance_m: null });
        setQueued("in");
      } catch {
        setError("Sem rede e não foi possível guardar offline. Não feche a aplicação e tente quando houver ligação.");
      }
      setLoading(false);
      endCriticalAction();
      return;
    }

    try {
      const res = await fetch("/api/app/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: serviceId, lat, lng, manual, gps_accuracy: accuracy, client_event_id }),
      });
      const json = await res.json();
      setLoading(false);
      endCriticalAction();
      if (!res.ok) {
        if (json.needsManualConfirm) { setNeedsManual("in"); return; }
        setError(json.error ?? "Erro ao registar entrada");
        return;
      }
      if (json.location_warning) setDistanceWarning(json.distance_m);
      setTimesheet(json.data);
    } catch {
      try {
        await queueTimesheet({ kind: "in", service_id: serviceId, lat, lng, at, manual, gps_accuracy: accuracy, client_event_id });
        setTimesheet({ id: `local-${Date.now()}`, clock_in_at: at, clock_out_at: null, location_warning: manual, clock_in_distance_m: null });
        setQueued("in");
      } catch {
        setError("Sem rede e não foi possível guardar offline. Não feche a aplicação e tente quando houver ligação.");
      }
      setLoading(false);
      endCriticalAction();
    }
  }

  async function doClockOut(manual = false) {
    setLoading(true);
    beginCriticalAction();
    setError(null);
    setNeedsManual(null);

    const coords = await getCoords();

    if (coords.gpsError && !manual) {
      setNeedsManual("out");
      setLoading(false);
      endCriticalAction();
      return;
    }

    const { lat, lng, accuracy } = coords;
    const at = new Date().toISOString();
    const client_event_id = uuid();

    if (isOffline()) {
      try {
        await queueTimesheet({ kind: "out", service_id: serviceId, lat, lng, at, manual, gps_accuracy: accuracy, client_event_id });
        setTimesheet((prev) => prev ? { ...prev, clock_out_at: at } : prev);
        setQueued("out");
      } catch {
        setError("Sem rede e não foi possível guardar offline. Não feche a aplicação e tente quando houver ligação.");
      }
      setLoading(false);
      endCriticalAction();
      return;
    }

    try {
      const res = await fetch("/api/app/timesheet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: serviceId, lat, lng, manual, gps_accuracy: accuracy, client_event_id }),
      });
      const json = await res.json();
      setLoading(false);
      endCriticalAction();
      if (!res.ok) {
        if (json.needsManualConfirm) { setNeedsManual("out"); return; }
        setError(json.error ?? "Erro ao registar saída");
        return;
      }
      setTimesheet(json.data);
    } catch {
      try {
        await queueTimesheet({ kind: "out", service_id: serviceId, lat, lng, at, manual, gps_accuracy: accuracy, client_event_id });
        setTimesheet((prev) => prev ? { ...prev, clock_out_at: at } : prev);
        setQueued("out");
      } catch {
        setError("Sem rede e não foi possível guardar offline. Não feche a aplicação e tente quando houver ligação.");
      }
      setLoading(false);
      endCriticalAction();
    }
  }

  /* ── Sem clock-in ─────────────────────────────────────── */
  if (!timesheet) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => singleFlight(() => doClockIn(false))}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full py-4 rounded-2xl bg-[var(--color-primary)] text-white font-semibold text-sm active:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <LogIn className="w-5 h-5" />
          )}
          {loading ? "A obter localização…" : "Bater Ponto"}
        </button>

        {needsManual === "in" && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 space-y-2">
            <div className="flex items-center gap-2 text-amber-800 text-xs font-medium">
              <MapPinOff className="w-4 h-4 shrink-0" />
              GPS indisponível ou acesso negado. Confirme que está no local para registar manualmente.
            </div>
            <button
              onClick={() => singleFlight(() => doClockIn(true))}
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-amber-600 text-white text-xs font-semibold active:bg-amber-700 transition-colors disabled:opacity-60"
            >
              Confirmo que estou no local — registar sem GPS
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-600 text-center">{error}</p>}
      </div>
    );
  }

  /* ── Clock-in feito, sem clock-out ───────────────────── */
  if (!timesheet.clock_out_at) {
    return (
      <div className="space-y-3">
        <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-sm font-semibold text-green-800">Em serviço</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-green-700">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            <span>Entrada às {fmt(timesheet.clock_in_at)}</span>
          </div>
          {(timesheet.location_warning || distanceWarning) && (
            <div className="flex items-center gap-2 text-xs text-amber-700 mt-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                A {distanceWarning ?? timesheet.clock_in_distance_m}m do local (aviso registado)
              </span>
            </div>
          )}
          {queued === "in" && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mt-1.5">
              <CloudOff className="w-3.5 h-3.5 shrink-0" />
              <span>Registado offline — sincroniza quando houver rede.</span>
            </div>
          )}
        </div>

        <button
          onClick={() => singleFlight(() => doClockOut(false))}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full py-4 rounded-2xl bg-red-600 text-white font-semibold text-sm active:bg-red-700 transition-colors disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <LogOut className="w-5 h-5" />
          )}
          {loading ? "A registar saída…" : "Terminar Ponto"}
        </button>

        {needsManual === "out" && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 space-y-2">
            <div className="flex items-center gap-2 text-amber-800 text-xs font-medium">
              <MapPinOff className="w-4 h-4 shrink-0" />
              GPS indisponível. Confirme que terminou o serviço para registar manualmente.
            </div>
            <button
              onClick={() => singleFlight(() => doClockOut(true))}
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-amber-600 text-white text-xs font-semibold active:bg-amber-700 transition-colors disabled:opacity-60"
            >
              Confirmo que terminei o serviço — registar sem GPS
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-600 text-center">{error}</p>}
      </div>
    );
  }

  /* ── Clock-out feito ──────────────────────────────────── */
  const minutes = Math.round(
    (new Date(timesheet.clock_out_at).getTime() - new Date(timesheet.clock_in_at).getTime()) / 60000
  );

  return (
    <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle className="w-4 h-4 text-green-600" />
        <span className="text-sm font-semibold text-green-800">Ponto registado</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-green-600 mb-0.5">Entrada</p>
          <p className="font-semibold text-green-800">{fmt(timesheet.clock_in_at)}</p>
        </div>
        <div>
          <p className="text-xs text-green-600 mb-0.5">Saída</p>
          <p className="font-semibold text-green-800">{fmt(timesheet.clock_out_at)}</p>
        </div>
      </div>
      <p className="text-xs text-green-700 mt-2 border-t border-green-200 pt-2">
        {Math.floor(minutes / 60)}h {minutes % 60}min trabalhadas
      </p>
      {queued === "out" && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] mt-2">
          <CloudOff className="w-3.5 h-3.5 shrink-0" />
          Registado offline — sincroniza quando houver rede.
        </p>
      )}
    </div>
  );
}
