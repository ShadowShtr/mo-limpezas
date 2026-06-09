"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Palmtree, Check, X, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { reviewVacationRequest, type VacationRequest } from "@/app/actions/vacation";

const STATUS_STYLE: Record<string, string> = {
  pendente:  "bg-amber-100 text-amber-700",
  aprovado:  "bg-green-100 text-green-700",
  rejeitado: "bg-red-100 text-red-700",
};
const STATUS_LABEL: Record<string, string> = {
  pendente: "Pendente", aprovado: "Aprovado", rejeitado: "Rejeitado",
};

function fmt(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });
}

export function VacationRequests({ requests }: { requests: VacationRequest[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [showAll, setShowAll] = useState(false);

  const pendentes = requests.filter((r) => r.status === "pendente");
  const outros = requests.filter((r) => r.status !== "pendente");
  const visible = showAll ? requests : pendentes;

  function approve(id: string) {
    startTransition(async () => {
      await reviewVacationRequest(id, "aprovado");
      router.refresh();
    });
  }
  function confirmReject() {
    if (!rejectId) return;
    const id = rejectId;
    startTransition(async () => {
      await reviewVacationRequest(id, "rejeitado", reason || undefined);
      setRejectId(null);
      setReason("");
      router.refresh();
    });
  }

  if (requests.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Palmtree className="w-4 h-4 text-[var(--color-primary)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Pedidos de férias</h3>
          {pendentes.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
              {pendentes.length} pendente{pendentes.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {outros.length > 0 && (
          <button onClick={() => setShowAll((s) => !s)}
            className="flex items-center gap-1 text-xs text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]">
            {showAll ? <>Ver só pendentes <ChevronUp className="w-3.5 h-3.5" /></> : <>Ver histórico <ChevronDown className="w-3.5 h-3.5" /></>}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)] py-8 text-center">Sem pedidos pendentes.</p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {visible.map((r) => (
            <div key={r.id} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-text-main)]">{r.collaborator_name}</p>
                  <p className="text-xs text-[var(--color-text-sub)] mt-0.5">
                    {fmt(r.starts_on)} – {fmt(r.ends_on)}
                    {r.days_count != null && <span className="text-[var(--color-text-muted)]"> · {r.days_count} dia(s) úteis</span>}
                  </p>
                  {r.notes && <p className="text-xs text-[var(--color-text-muted)] mt-1">{r.notes}</p>}
                </div>
                {r.status === "pendente" ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => approve(r.id)} disabled={pending}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-green-200 text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-40">
                      <Check className="w-3.5 h-3.5" /> Aprovar
                    </button>
                    <button onClick={() => { setRejectId(r.id); setReason(""); }} disabled={pending}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-40">
                      <X className="w-3.5 h-3.5" /> Rejeitar
                    </button>
                  </div>
                ) : (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_STYLE[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </span>
                )}
              </div>
              {r.status === "rejeitado" && r.rejection_reason && (
                <p className="text-xs text-red-600 mt-1.5">Motivo: {r.rejection_reason}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal de rejeição */}
      {rejectId && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setRejectId(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl border border-[var(--color-border)] w-full max-w-sm p-5">
              <h3 className="text-base font-semibold text-[var(--color-text-main)] mb-1">Rejeitar pedido</h3>
              <p className="text-xs text-[var(--color-text-muted)] mb-3">Indica o motivo (opcional). O colaborador será notificado.</p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                placeholder="Motivo da rejeição..."
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] resize-none" />
              <div className="flex gap-2 mt-4">
                <button onClick={() => setRejectId(null)}
                  className="flex-1 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">
                  Cancelar
                </button>
                <button onClick={confirmReject} disabled={pending}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                  {pending && <Loader2 className="w-4 h-4 animate-spin" />} Rejeitar
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
