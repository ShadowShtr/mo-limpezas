"use client";

import { useState } from "react";
import { Trash2, UserCheck, AlertCircle } from "lucide-react";
import { deleteAbsence } from "@/app/actions/absences";
import { SubstitutionPanel } from "./substitution-panel";

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa: "Doença (c/ baixa)",
  doenca_sem_baixa: "Doença (s/ baixa)",
  pessoal_justificado: "Pessoal justificado",
  pessoal_injustificado: "Pessoal injustificado",
  ferias: "Férias",
  feriado: "Feriado",
  formacao: "Formação",
  outro: "Outro",
};

const ABSENCE_COLORS: Record<string, string> = {
  doenca_com_baixa: "bg-red-100 text-red-700",
  doenca_sem_baixa: "bg-orange-100 text-orange-700",
  pessoal_justificado: "bg-blue-100 text-blue-700",
  pessoal_injustificado: "bg-red-200 text-red-800",
  ferias: "bg-green-100 text-green-700",
  feriado: "bg-purple-100 text-purple-700",
  formacao: "bg-sky-100 text-sky-700",
  outro: "bg-gray-100 text-gray-700",
};

export interface AbsenceRow {
  id: string;
  collaborator_id: string;
  collaborator_name: string;
  absence_type: string;
  starts_on: string;
  ends_on: string;
  notes: string | null;
  replaced_by: string | null;
  replaced_by_name: string | null;
  is_new?: boolean;
}

interface Props {
  absences: AbsenceRow[];
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function dayCount(starts: string, ends: string) {
  const a = new Date(starts + "T00:00:00");
  const b = new Date(ends + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function AbsenceTable({ absences }: Props) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [substitutionFor, setSubstitutionFor] = useState<AbsenceRow | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Eliminar esta falta?")) return;
    setDeleting(id);
    await deleteAbsence(id);
    setDeleting(null);
  }

  if (absences.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--color-text-muted)]">
        <AlertCircle className="w-10 h-10 mb-3 opacity-30" />
        <p className="text-sm">Nenhuma falta registada no período.</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)] text-xs uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Colaborador</th>
              <th className="text-left px-4 py-3 font-medium">Tipo</th>
              <th className="text-left px-4 py-3 font-medium">Período</th>
              <th className="text-left px-4 py-3 font-medium">Dias</th>
              <th className="text-left px-4 py-3 font-medium">Substituto</th>
              <th className="text-left px-4 py-3 font-medium">Notas</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {absences.map((row) => (
              <tr key={row.id} className="hover:bg-[var(--color-background)] transition-colors">
                <td className="px-4 py-3 font-medium text-[var(--color-text-main)]">
                  <span className="flex items-center gap-2">
                    {row.collaborator_name}
                    {row.is_new && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                        Novo
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${ABSENCE_COLORS[row.absence_type] ?? "bg-gray-100 text-gray-700"}`}>
                    {ABSENCE_LABELS[row.absence_type] ?? row.absence_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-[var(--color-text-sub)]">
                  {formatDate(row.starts_on)}
                  {row.starts_on !== row.ends_on && (
                    <> → {formatDate(row.ends_on)}</>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-text-sub)]">
                  {dayCount(row.starts_on, row.ends_on)}d
                </td>
                <td className="px-4 py-3">
                  {row.replaced_by_name ? (
                    <span className="flex items-center gap-1.5 text-[var(--color-primary)] text-xs font-medium">
                      <UserCheck className="w-3.5 h-3.5" />
                      {row.replaced_by_name}
                    </span>
                  ) : (
                    <button
                      onClick={() => setSubstitutionFor(row)}
                      className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)] underline underline-offset-2 transition-colors"
                    >
                      Sugerir substituto
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-text-muted)] max-w-[180px] truncate">
                  {row.notes ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleDelete(row.id)}
                    disabled={deleting === row.id}
                    className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-red-50 transition-colors disabled:opacity-40"
                    title="Eliminar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {substitutionFor && (
        <SubstitutionPanel
          absence={substitutionFor}
          onClose={() => setSubstitutionFor(null)}
        />
      )}
    </>
  );
}
