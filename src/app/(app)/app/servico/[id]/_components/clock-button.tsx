"use client";

import { useState } from "react";
import { LogIn, LogOut, MapPin, AlertTriangle, Loader2, CheckCircle, CloudOff } from "lucide-react";
import { queueTimesheet } from "@/lib/offline-sync";

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

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("GPS não disponível"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
    });
  });
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

  async function getCoords(): Promise<{ lat: number | null; lng: number | null }> {
    try {
      const pos = await getPosition();
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch {
      return { lat: null, lng: null };
    }
  }

  async function handleClockIn() {
    setLoading(true);
    setError(null);
    setDistanceWarning(null);

    const { lat, lng } = await getCoords();
    const at = new Date().toISOString();

    // Sem rede: guardar em fila e mostrar como registado
    if (isOffline()) {
      queueTimesheet({ kind: "in", service_id: serviceId, lat, lng, at });
      setTimesheet({ id: `local-${Date.now()}`, clock_in_at: at, clock_out_at: null, location_warning: false, clock_in_distance_m: null });
      setQueued("in");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/app/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: serviceId, lat, lng }),
      });
      const json = await res.json();
      setLoading(false);
      if (!res.ok) { setError(json.error ?? "Erro ao registar entrada"); return; }
      if (json.location_warning) setDistanceWarning(json.distance_m);
      setTimesheet(json.data);
    } catch {
      // Falhou por rede: cair para a fila
      queueTimesheet({ kind: "in", service_id: serviceId, lat, lng, at });
      setTimesheet({ id: `local-${Date.now()}`, clock_in_at: at, clock_out_at: null, location_warning: false, clock_in_distance_m: null });
      setQueued("in");
      setLoading(false);
    }
  }

  async function handleClockOut() {
    setLoading(true);
    setError(null);

    const { lat, lng } = await getCoords();
    const at = new Date().toISOString();

    if (isOffline()) {
      queueTimesheet({ kind: "out", service_id: serviceId, lat, lng, at });
      setTimesheet((prev) => prev ? { ...prev, clock_out_at: at } : prev);
      setQueued("out");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/app/timesheet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: serviceId, lat, lng }),
      });
      const json = await res.json();
      setLoading(false);
      if (!res.ok) { setError(json.error ?? "Erro ao registar saída"); return; }
      setTimesheet(json.data);
    } catch {
      queueTimesheet({ kind: "out", service_id: serviceId, lat, lng, at });
      setTimesheet((prev) => prev ? { ...prev, clock_out_at: at } : prev);
      setQueued("out");
      setLoading(false);
    }
  }

  /* ── Sem clock-in ─────────────────────────────────────── */
  if (!timesheet) {
    return (
      <div className="space-y-2">
        <button
          onClick={handleClockIn}
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
          onClick={handleClockOut}
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
