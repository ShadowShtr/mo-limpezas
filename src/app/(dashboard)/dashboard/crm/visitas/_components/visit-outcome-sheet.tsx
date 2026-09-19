"use client";

// ============================================================================
// O que a visita deu
// ============================================================================
//
// A área, as horas estimadas e a periodicidade são a razão de a visita existir:
// é o que se foi lá medir, e é o que vai pré-preencher as linhas do orçamento.
// Registá-las aqui poupa a segunda viagem — ao local, ou à memória de alguém.
//
// As datas de desfecho não são pedidas: a action põe-nas. A base exige-as
// (CHECK da 102) e ninguém deve ter de escrever à mão a data de hoje.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import {
  VISIT_CLOSING_STATUSES,
  VISIT_STATUS_LABELS,
  type VisitClosingStatus,
} from "@/lib/crm/visits";
import { setVisitOutcome, type VisitRow } from "@/app/actions/crm-visitas";

const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

interface Props {
  visita: VisitRow;
  /**
   * 🔴 Uma visita fechada é história.
   *
   *    O botão «Ver» de uma visita já realizada, cancelada ou não comparecida
   *    abria este mesmo painel em modo de escrita — e gravar voltava a
   *    reescrever estado, datas, área, horas e notas, sem rasto e sem fluxo
   *    próprio. Aqui os dados mostram-se; corrigir um desfecho histórico é
   *    outro problema, com auditoria própria, e não se resolve deixando este
   *    formulário aberto.
   */
  soLeitura?: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function VisitOutcomeSheet({ visita, soLeitura = false, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  // A fechar: o desfecho mais provável, para se mudar num clique. A ver: o
  // desfecho que a visita teve — mostrar «realizada» numa visita cancelada
  // seria mentir sobre o que aconteceu.
  const [status, setStatus] = useState<VisitClosingStatus>(() =>
    soLeitura && (VISIT_CLOSING_STATUSES as readonly string[]).includes(visita.status)
      ? (visita.status as VisitClosingStatus)
      : "realizada",
  );
  const [notas, setNotas] = useState(visita.outcome_notes ?? "");
  const [area, setArea] = useState(visita.area_sqm?.toString() ?? "");
  const [horas, setHoras] = useState(visita.estimated_hours?.toString() ?? "");
  const [frequencia, setFrequencia] = useState(visita.frequency_hint ?? "");
  const [motivo, setMotivo] = useState(visita.cancel_reason ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const mediu = status === "realizada";

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    // Cinto e suspensórios: o botão nem existe em só-leitura, mas um submit
    // por Enter não pode ser a porta das traseiras.
    if (soLeitura) return;

    startTransition(async () => {
      const res = await setVisitOutcome(visita.id, {
        status,
        outcomeNotes: notas || null,
        // O que só faz sentido numa visita realizada não viaja nas outras: uma
        // área medida numa visita a que ninguém foi seria um número inventado.
        areaSqm: mediu && area ? Number(area) : null,
        estimatedHours: mediu && horas ? Number(horas) : null,
        frequencyHint: mediu ? frequencia || null : null,
        cancelReason: status === "cancelada" ? motivo || null : null,
      });

      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      onDone();
    });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-resultado"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <form onSubmit={submeter} className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2 id="titulo-resultado" className="text-[15px] font-semibold">Resultado da visita</h2>
            <p className="text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
              {visita.target_name}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Fechar" className="rounded-lg p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <fieldset>
            <legend className="text-[12.5px] font-medium">O que aconteceu</legend>
            <div className="mt-2 space-y-1.5">
              {VISIT_CLOSING_STATUSES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="radio"
                    disabled={soLeitura}
                    name="status"
                    value={s}
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  {VISIT_STATUS_LABELS[s]}
                </label>
              ))}
            </div>
          </fieldset>

          {mediu && (
            <div
              className="rounded-lg border p-3"
              style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
            >
              <p className="text-[12px] font-semibold">O que foi medido</p>
              <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                É daqui que sai o orçamento.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="block text-[12.5px] font-medium">
                  Área (m²)
                  <input
                    type="number"
                    disabled={soLeitura}
                    min="0"
                    step="0.01"
                    value={area}
                    onChange={(e) => setArea(e.target.value)}
                    className={CAMPO}
                  />
                </label>
                <label className="block text-[12.5px] font-medium">
                  Horas estimadas
                  <input
                    type="number"
                    disabled={soLeitura}
                    min="0"
                    step="0.25"
                    value={horas}
                    onChange={(e) => setHoras(e.target.value)}
                    className={CAMPO}
                  />
                </label>
              </div>
              <label className="mt-3 block text-[12.5px] font-medium">
                Periodicidade combinada
                <input
                  disabled={soLeitura}
                  value={frequencia}
                  onChange={(e) => setFrequencia(e.target.value)}
                  placeholder="2x por semana, quinzenal…"
                  className={CAMPO}
                />
              </label>
            </div>
          )}

          {status === "cancelada" && (
            <label className="block text-[12.5px] font-medium">
              Motivo do cancelamento
              <input
                disabled={soLeitura}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className={CAMPO}
              />
            </label>
          )}

          <label className="block text-[12.5px] font-medium">
            Notas do local
            <textarea
              disabled={soLeitura}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="Escadas, número de pisos, acessos, o que o cliente pediu…"
              className={CAMPO}
            />
          </label>
        </div>

        <div
          className="flex justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Fechar
          </button>
          {!soLeitura && (
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
              style={{ background: "#16A34A" }}
            >
              {pending ? "A guardar…" : "Guardar resultado"}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
