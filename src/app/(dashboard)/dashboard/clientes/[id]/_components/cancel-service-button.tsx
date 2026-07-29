"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Ban, AlertTriangle, X } from "lucide-react";
import { cancelService } from "@/app/actions/cancellations";
import { CANCEL_TYPE_LABELS, type CancelType } from "@/lib/cancel-types";

export function CancelServiceButton({
  serviceId,
  teamId,
  scheduledStart,
}: {
  serviceId: string;
  teamId: string | null;
  scheduledStart: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cancelType, setCancelType] = useState<CancelType>("client_request");
  const [reason, setReason] = useState("");
  const [notifyTeamMembers, setNotifyTeamMembers] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLateCancelWarning = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const hoursUntil = (new Date(scheduledStart).getTime() - Date.now()) / 3_600_000;
    return hoursUntil < 24 && hoursUntil > -24;
  }, [scheduledStart]);

  function reset() {
    setCancelType("client_request");
    setReason("");
    setNotifyTeamMembers(true);
    setError(null);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    const res = await cancelService(serviceId, cancelType, reason, notifyTeamMembers);
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Erro ao cancelar.");
      return;
    }
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        title="Cancelar serviço"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-red-50 hover:text-red-600 hover:border-red-200 shrink-0 transition-colors"
      >
        <Ban className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !loading) { setOpen(false); reset(); } }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-red-100 bg-red-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-red-800 flex items-center gap-1.5">
                <Ban className="w-4 h-4" /> Cancelar serviço
              </p>
              <button
                type="button"
                onClick={() => { if (!loading) { setOpen(false); reset(); } }}
                className="text-red-400 hover:text-red-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 space-y-4">
              {isLateCancelWarning && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Cancelamento tardio — menos de 24h de antecedência. Ficará registado.</span>
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-[var(--color-text-sub)] mb-2">Motivo *</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {(Object.entries(CANCEL_TYPE_LABELS) as [CancelType, string][]).map(([k, v]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setCancelType(k)}
                      className={`px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-colors border ${
                        cancelType === k
                          ? "bg-red-600 text-white border-red-600"
                          : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:bg-red-50"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">
                  Descrição <span className="font-normal text-[var(--color-text-muted)]">(opcional)</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-transparent resize-none"
                  placeholder="Ex: cliente pediu reagendamento para semana seguinte..."
                />
              </div>

              {teamId && (
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <div
                    onClick={() => setNotifyTeamMembers((v) => !v)}
                    className={`w-9 h-5 rounded-full transition-colors shrink-0 flex items-center ${notifyTeamMembers ? "bg-red-600" : "bg-gray-300"}`}
                  >
                    <span className={`w-4 h-4 bg-white rounded-full shadow transition-all mx-0.5 ${notifyTeamMembers ? "translate-x-4" : "translate-x-0"}`} />
                  </div>
                  <span className="text-sm text-[var(--color-text-main)]">Notificar equipa por push</span>
                </label>
              )}

              {error && (
                <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {loading ? "A cancelar..." : "Confirmar cancelamento"}
                </button>
                <button
                  type="button"
                  onClick={() => { if (!loading) { setOpen(false); reset(); } }}
                  disabled={loading}
                  className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
                >
                  Voltar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
