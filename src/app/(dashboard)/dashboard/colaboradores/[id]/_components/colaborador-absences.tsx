"use client";

import { AlertTriangle, Plus, UserCheck } from "lucide-react";
import { AbsenceSheet } from "@/app/(dashboard)/dashboard/faltas/_components/absence-sheet";

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa: "Doença c/ baixa",
  doenca_sem_baixa: "Doença s/ baixa",
  pessoal_justificado: "Pessoal justif.",
  pessoal_injustificado: "Pessoal injustif.",
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

export interface AbsenceItem {
  id: string;
  absence_type: string;
  starts_on: string;
  ends_on: string;
  notes: string | null;
  replaced_by_name: string | null;
}

interface Props {
  colaboradorId: string;
  colaboradorName: string;
  absences: AbsenceItem[];
}

function fmt(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "short",
  });
}

function days(s: string, e: string) {
  return Math.round((new Date(e + "T00:00:00").getTime() - new Date(s + "T00:00:00").getTime()) / 86400000) + 1;
}

export function ColaboradorAbsences({ colaboradorId, colaboradorName, absences }: Props) {
  const colaboradores = [{ id: colaboradorId, full_name: colaboradorName }];

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Faltas</h3>
          {absences.length > 0 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
              {absences.length}
            </span>
          )}
        </div>
        <AbsenceSheet
          colaboradores={colaboradores}
          defaultCollaboratorId={colaboradorId}
          trigger={
            <button className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
              <Plus className="w-3.5 h-3.5" />
              Registar
            </button>
          }
        />
      </div>

      {absences.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
          Sem faltas registadas.
        </p>
      ) : (
        <div className="space-y-2">
          {absences.map((a) => (
            <div key={a.id} className="flex items-start gap-3 py-2 border-b border-[var(--color-border)] last:border-0">
              <span className={`mt-0.5 inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${ABSENCE_COLORS[a.absence_type] ?? "bg-gray-100 text-gray-700"}`}>
                {ABSENCE_LABELS[a.absence_type] ?? a.absence_type}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[var(--color-text-main)]">
                  {fmt(a.starts_on)}
                  {a.starts_on !== a.ends_on && <> → {fmt(a.ends_on)}</>}
                  <span className="text-[var(--color-text-muted)] ml-1">({days(a.starts_on, a.ends_on)}d)</span>
                </p>
                {a.replaced_by_name && (
                  <p className="text-[10px] text-[var(--color-primary)] flex items-center gap-1 mt-0.5">
                    <UserCheck className="w-3 h-3" />
                    {a.replaced_by_name}
                  </p>
                )}
                {a.notes && (
                  <p className="text-[10px] text-[var(--color-text-muted)] truncate mt-0.5">{a.notes}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
