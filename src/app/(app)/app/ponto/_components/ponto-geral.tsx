"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, LogOut, Loader2, Check } from "lucide-react";

type Clock = {
  clock_in_at: string | null;
  clock_out_at: string | null;
};
type Action = "clock_in" | "clock_out";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false });
}

function getCoords(): Promise<{ lat: number | null; lng: number | null }> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { enableHighAccuracy: true, timeout: 6000 },
    );
  });
}

export function PontoGeral({ initial }: { initial: Clock | null }) {
  const router = useRouter();
  const [clock, setClock] = useState<Clock>(initial ?? { clock_in_at: null, clock_out_at: null });
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doAction(action: Action) {
    setBusy(action); setError(null);
    const { lat, lng } = await getCoords();
    try {
      const res = await fetch("/api/app/daily-clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, lat, lng }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Erro ao registar o ponto."); return; }
      setClock(json.data);
      router.refresh();
    } catch {
      setError("Sem ligação. Tenta novamente.");
    } finally {
      setBusy(null);
    }
  }

  const started = !!clock.clock_in_at;
  const ended = !!clock.clock_out_at;

  const totalLabel = (() => {
    if (!clock.clock_in_at) return null;
    const end = clock.clock_out_at ? new Date(clock.clock_out_at) : new Date();
    const mins = Math.max(0, Math.round((end.getTime() - new Date(clock.clock_in_at).getTime()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h}h${m > 0 ? ` ${m}min` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Estado / total */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">Estado</p>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">
              {ended ? "Dia terminado" : started ? "A trabalhar" : "Por iniciar"}
            </p>
          </div>
          {totalLabel && (
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">Total {ended ? "" : "(em curso)"}</p>
              <p className="text-lg font-bold text-[var(--color-primary)]">{totalLabel}</p>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
          <Row label="Início" value={fmt(clock.clock_in_at)} />
          <Row label="Fim" value={fmt(clock.clock_out_at)} />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* Ações */}
      <div className="grid grid-cols-1 gap-3">
        {!started ? (
          <BigButton onClick={() => doAction("clock_in")} busy={busy === "clock_in"} icon={LogIn} primary>
            Iniciar trabalho
          </BigButton>
        ) : !ended ? (
          <BigButton onClick={() => doAction("clock_out")} busy={busy === "clock_out"} icon={LogOut} danger>
            Terminar trabalho
          </BigButton>
        ) : (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-[var(--color-primary-muted)] bg-[var(--color-primary-light)] py-4 text-sm font-medium text-[var(--color-primary)]">
            <Check className="w-5 h-5" /> Ponto do dia concluído
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[var(--color-background)] px-3 py-2">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="font-semibold text-[var(--color-text-main)]">{value}</span>
    </div>
  );
}

function BigButton({
  children, onClick, busy, icon: Icon, primary, danger,
}: {
  children: React.ReactNode; onClick: () => void; busy: boolean;
  icon: React.ComponentType<{ className?: string }>; primary?: boolean; danger?: boolean;
}) {
  const base = "flex items-center justify-center gap-2 rounded-xl py-4 text-sm font-semibold transition-colors disabled:opacity-60";
  const cls = primary
    ? "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
    : danger
    ? "bg-red-600 text-white hover:bg-red-700"
    : "border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]";
  return (
    <button type="button" onClick={onClick} disabled={busy} className={`${base} ${cls}`}>
      {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Icon className="w-5 h-5" />}
      {children}
    </button>
  );
}
