"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2, Stethoscope, CalendarDays, AlertCircle } from "lucide-react";
import { createOwnAbsence } from "@/app/actions/vacation";

interface AbsenceRow {
  id: string;
  absence_type: string;
  starts_on: string;
  ends_on: string;
  notes: string | null;
  created_at: string;
}

interface Props {
  absences: AbsenceRow[];
}

const ABSENCE_LABEL: Record<string, string> = {
  doenca_com_baixa: "Doença (com baixa)",
  doenca_sem_baixa: "Doença (sem baixa)",
  pessoal_justificado: "Pessoal justificado",
  pessoal_injustificado: "Pessoal injustificado",
  ferias: "Férias",
  feriado: "Feriado",
  formacao: "Formação",
  outro: "Outro",
};

function fmt(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
}

const inputCls = "w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white";

export function AusenciasClient({ absences }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [absType, setAbsType] = useState<"doenca_com_baixa" | "doenca_sem_baixa" | "pessoal_justificado" | "outro">("doenca_sem_baixa");
  const today = new Date().toISOString().split("T")[0];
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    startTransition(async () => {
      const res = await createOwnAbsence({ absence_type: absType, starts_on: start, ends_on: end, notes: notes || undefined });
      if (!res.ok) { setErr(res.error); return; }
      setOpen(false);
      setNotes("");
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => { setErr(""); setOpen(true); }}
        className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl bg-[var(--color-primary)] text-white font-semibold text-sm active:bg-[var(--color-primary-hover)] transition-colors"
      >
        <Plus className="w-4 h-4" />
        Registar falta
      </button>

      {/* Faltas */}
      <div>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Stethoscope className="w-3.5 h-3.5" /> Minhas faltas
        </h2>
        {absences.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] bg-white rounded-2xl border border-[var(--color-border)] p-4 text-center">
            Sem faltas registadas.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {absences.map((a) => (
              <div key={a.id} className="bg-white rounded-2xl border border-[var(--color-border)] p-4 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--color-text-main)]">
                    {ABSENCE_LABEL[a.absence_type] ?? a.absence_type}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5 flex items-center gap-1">
                    <CalendarDays className="w-3 h-3" /> {fmt(a.starts_on)} – {fmt(a.ends_on)}
                  </p>
                  {a.notes && <p className="text-xs text-[var(--color-text-sub)] mt-1">{a.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sheet de criação */}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl shadow-xl max-h-[90vh] overflow-y-auto safe-area-pb">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] sticky top-0 bg-white">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Nova falta</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] active:bg-[var(--color-background)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={submit} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Tipo de falta</label>
                <select value={absType} onChange={(e) => setAbsType(e.target.value as typeof absType)} className={inputCls}>
                  <option value="doenca_sem_baixa">Doença (sem baixa)</option>
                  <option value="doenca_com_baixa">Doença (com baixa)</option>
                  <option value="pessoal_justificado">Pessoal justificado</option>
                  <option value="outro">Outro</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Início</label>
                  <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Fim</label>
                  <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} required />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Notas (opcional)</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                  placeholder="Motivo, detalhes..." className={inputCls + " resize-none"} />
              </div>

              {err && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {err}
                </div>
              )}

              <button type="submit" disabled={pending}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[var(--color-primary)] text-white font-semibold text-sm active:bg-[var(--color-primary-hover)] disabled:opacity-50">
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                Registar falta
              </button>
            </form>
          </div>
        </>
      )}
    </>
  );
}
