"use client";

import { useState, useTransition } from "react";
import { Clock, AlertTriangle, Pencil, Check, X, Loader2 } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { adminEditTimesheet } from "@/app/actions/timesheets";

type Timesheet = {
  id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  duration_minutes: number | null;
  location_warning: boolean;
  service_id: string;
};

interface Props {
  timesheets: Timesheet[];
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(minutes: number | null) {
  if (!minutes) return "—";
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

interface EditRowProps {
  t: Timesheet;
  onDone: (updated: Partial<Timesheet>) => void;
  onCancel: () => void;
}

function EditRow({ t, onDone, onCancel }: EditRowProps) {
  const [inAt, setInAt] = useState(toLocalInput(t.clock_in_at));
  const [outAt, setOutAt] = useState(toLocalInput(t.clock_out_at));
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function handleSave() {
    setError("");
    startTransition(async () => {
      const inIso = inAt ? new Date(inAt).toISOString() : null;
      const outIso = outAt ? new Date(outAt).toISOString() : null;
      if (inIso && outIso && new Date(outIso) <= new Date(inIso)) {
        setError("Saída tem de ser depois da entrada.");
        return;
      }
      const res = await adminEditTimesheet(t.id, {
        clock_in_at: inIso,
        clock_out_at: outIso,
        notes: notes || null,
      });
      if (!res.ok) { setError(res.error ?? "Erro ao guardar."); return; }
      const dm = inIso && outIso
        ? Math.round((new Date(outIso).getTime() - new Date(inIso).getTime()) / 60000)
        : null;
      onDone({ clock_in_at: inIso, clock_out_at: outIso, duration_minutes: dm });
    });
  }

  const inputCls = "px-2 py-1 rounded border border-[var(--color-border)] text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] bg-white";

  return (
    <>
      <td className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
        {inAt ? new Date(inAt).toLocaleDateString("pt-PT", { day: "numeric", month: "short" }) : "—"}
      </td>
      <td className="px-4 py-2">
        <input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} className={inputCls} />
      </td>
      <td className="px-4 py-2">
        <input type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} className={inputCls} />
      </td>
      <td className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
        {inAt && outAt
          ? formatDuration(Math.round((new Date(outAt).getTime() - new Date(inAt).getTime()) / 60000))
          : "—"}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            disabled={pending}
            className="p-1 rounded text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors disabled:opacity-50"
            title="Guardar"
          >
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onCancel}
            className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
            title="Cancelar"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          {error && <span className="text-xs text-red-500 ml-1">{error}</span>}
        </div>
      </td>
    </>
  );
}

export function PresencaHistory({ timesheets: initial }: Props) {
  const [timesheets, setTimesheets] = useState<Timesheet[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);

  function applyUpdate(id: string, updated: Partial<Timesheet>) {
    setTimesheets((prev) => prev.map((t) => t.id === id ? { ...t, ...updated } : t));
    setEditingId(null);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
        <Clock className="w-4 h-4 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Histórico de presenças</h3>
        <span className="ml-auto text-xs text-[var(--color-text-muted)]">últimos 30 registos</span>
      </div>

      {timesheets.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Nenhum registo de ponto ainda.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Data</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Entrada</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Saída</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Duração</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {timesheets.map((t) => {
                if (editingId === t.id) {
                  return (
                    <tr key={t.id} className="bg-[var(--color-primary-light)]">
                      <EditRow
                        t={t}
                        onDone={(updated) => applyUpdate(t.id, updated)}
                        onCancel={() => setEditingId(null)}
                      />
                    </tr>
                  );
                }

                const date = t.clock_in_at
                  ? new Date(t.clock_in_at).toLocaleDateString("pt-PT", { day: "numeric", month: "short", year: "numeric" })
                  : "—";

                return (
                  <tr key={t.id} className="hover:bg-[var(--color-background)] transition-colors group">
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{date}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                      {t.clock_in_at ? formatTime(t.clock_in_at) : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                      {t.clock_out_at ? formatTime(t.clock_out_at) : (
                        <span className="text-xs text-[var(--color-warning)]">Em curso</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-[var(--color-text-main)]">{formatDuration(t.duration_minutes)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {t.location_warning && (
                          <span title="Fora do raio GPS">
                            <AlertTriangle className="w-4 h-4 text-[var(--color-warning)]" />
                          </span>
                        )}
                        <button
                          onClick={() => setEditingId(t.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-all"
                          title="Corrigir ponto"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
