"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { createAbsence, type AbsenceType } from "@/app/actions/absences";

const ABSENCE_OPTIONS: { value: AbsenceType; label: string }[] = [
  { value: "doenca_com_baixa", label: "Doença com baixa médica" },
  { value: "doenca_sem_baixa", label: "Doença sem baixa médica" },
  { value: "pessoal_justificado", label: "Pessoal justificado" },
  { value: "pessoal_injustificado", label: "Pessoal injustificado" },
  { value: "ferias", label: "Férias" },
  { value: "feriado", label: "Feriado" },
  { value: "formacao", label: "Formação" },
  { value: "outro", label: "Outro" },
];

interface Colaborador {
  id: string;
  full_name: string;
}

interface Props {
  trigger: React.ReactElement;
  colaboradores: Colaborador[];
  defaultCollaboratorId?: string;
}

export function AbsenceSheet({ trigger, colaboradores, defaultCollaboratorId }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const today = new Date().toISOString().split("T")[0];
  const [collaboratorId, setCollaboratorId] = useState(defaultCollaboratorId ?? "");
  const [absenceType, setAbsenceType] = useState<AbsenceType>("doenca_sem_baixa");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(today);
  const [notes, setNotes] = useState("");

  function resetForm() {
    setCollaboratorId(defaultCollaboratorId ?? "");
    setAbsenceType("doenca_sem_baixa");
    setStartsOn(today);
    setEndsOn(today);
    setNotes("");
    setMessage(null);
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!collaboratorId) {
      setMessage({ type: "error", text: "Seleciona um colaborador." });
      return;
    }
    if (endsOn < startsOn) {
      setMessage({ type: "error", text: "A data de fim não pode ser anterior à de início." });
      return;
    }

    setLoading(true);
    setMessage(null);

    const result = await createAbsence({
      collaborator_id: collaboratorId,
      absence_type: absenceType,
      starts_on: startsOn,
      ends_on: endsOn,
      notes: notes.trim() || undefined,
    });

    setLoading(false);

    if (!result.ok) {
      setMessage({ type: "error", text: "Erro ao registar falta. Tenta novamente." });
    } else {
      setMessage({ type: "success", text: "Falta registada com sucesso." });
      setTimeout(() => {
        setOpen(false);
        resetForm();
      }, 1000);
    }
  }

  const overlay = open && typeof window !== "undefined" ? createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        style={{ background: "rgba(9,14,26,0.45)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
        onClick={() => setOpen(false)}
      />
      <div
        className="fixed right-0 top-0 h-screen w-full max-w-md z-[9999] flex flex-col"
        style={{
          background: "rgba(255,255,255,0.97)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "-8px 0 40px rgba(9,14,26,0.14), -1px 0 0 rgba(15,23,42,0.07)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">Registar Falta</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Preenche os dados da ausência.</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form id="absence-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4 min-h-0">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Colaborador *</label>
            <select
              required
              value={collaboratorId}
              onChange={(e) => setCollaboratorId(e.target.value)}
              className={inputCls}
            >
              <option value="">Selecionar colaborador…</option>
              {colaboradores.map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Tipo de ausência *</label>
            <select
              required
              value={absenceType}
              onChange={(e) => setAbsenceType(e.target.value as AbsenceType)}
              className={inputCls}
            >
              {ABSENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data início *</label>
              <input
                required
                type="date"
                value={startsOn}
                onChange={(e) => { setStartsOn(e.target.value); if (e.target.value > endsOn) setEndsOn(e.target.value); }}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data fim *</label>
              <input
                required
                type="date"
                value={endsOn}
                min={startsOn}
                onChange={(e) => setEndsOn(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Notas</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Observações adicionais (opcional)…"
              className={inputCls + " resize-none"}
            />
          </div>

          {message && (
            <div className={`text-sm px-3 py-2 rounded-lg ${
              message.type === "error"
                ? "bg-red-50 text-[var(--color-danger)] border border-red-100"
                : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"
            }`}>
              {message.text}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-4">
          <button
            form="absence-form"
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold transition-all disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
              boxShadow: "0 4px 14px rgba(34,197,94,0.35)",
            }}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Registar falta
          </button>
        </div>
      </div>
    </>
  , document.body) : null;

  return (
    <>
      <span
        onClick={() => { resetForm(); setOpen(true); }}
        style={{ display: "contents", cursor: "pointer" }}
      >
        {trigger}
      </span>
      {overlay}
    </>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";
