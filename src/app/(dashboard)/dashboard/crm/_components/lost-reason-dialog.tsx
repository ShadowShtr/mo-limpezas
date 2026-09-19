"use client";

// ============================================================================
// «Porque é que se perdeu?»
// ============================================================================
//
// Aparece antes de gravar, e não depois de a base recusar.
//
// O CHECK `crm_leads_perdida_exige_motivo` da migration 101 é a última linha
// de defesa e faz bem em existir — mas se fosse a primeira, quem arrastasse um
// cartão para "Perdido" levaria com um erro de restrição no ecrã. Perguntar
// aqui é a diferença entre um formulário e uma armadilha.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { LEAD_LOST_REASONS, LEAD_LOST_REASON_LABELS } from "@/lib/crm/sources";

interface Props {
  leadName: string;
  onCancel: () => void;
  onConfirm: (motivo: string, notas: string | null) => void;
}

export function LostReasonDialog({ leadName, onCancel, onConfirm }: Props) {
  const [motivo, setMotivo] = useState<string>("");
  const [notas, setNotas] = useState("");
  const primeiroRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    primeiroRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-perda"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <h2 id="titulo-perda" className="text-[15px] font-semibold">
          Dar como perdida
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {leadName}
        </p>

        <label className="mt-4 block text-[13px] font-medium">
          Motivo
          <select
            ref={primeiroRef}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal"
            style={{ borderColor: "var(--color-border)" }}
          >
            <option value="">Escolha um motivo…</option>
            {LEAD_LOST_REASONS.map((r) => (
              <option key={r} value={r}>
                {LEAD_LOST_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-[13px] font-medium">
          Detalhe <span className="font-normal" style={{ color: "var(--color-text-muted)" }}>(opcional)</span>
          <textarea
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="O que ficou dito"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal"
            style={{ borderColor: "var(--color-border)" }}
          />
        </label>

        <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
          O motivo fica registado para se poder saber, mais tarde, porque é que
          se perde trabalho. A lead não é apagada.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(motivo, notas.trim() || null)}
            disabled={!motivo}
            className="rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
            style={{ background: "#DC2626" }}
          >
            Dar como perdida
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
