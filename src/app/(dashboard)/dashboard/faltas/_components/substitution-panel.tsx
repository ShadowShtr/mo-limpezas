"use client";

import { useState, useEffect } from "react";
import { X, Loader2, UserCheck, CheckCircle2, Users } from "lucide-react";
import { getSubstituteSuggestions, updateAbsenceSubstitute, type SubstituteSuggestion } from "@/app/actions/absences";
import type { AbsenceRow } from "./absence-table";

interface Props {
  absence: AbsenceRow;
  onClose: () => void;
}

export function SubstitutionPanel({ absence, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<SubstituteSuggestion[]>([]);
  const [selected, setSelected] = useState<string | null>(absence.replaced_by);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const result = await getSubstituteSuggestions(
        absence.collaborator_id,
        absence.starts_on,
        absence.ends_on,
      );
      if (result.ok) {
        setSuggestions(result.data);
      } else {
        setError(result.error);
      }
      setLoading(false);
    }
    load();
  }, [absence]);

  async function handleConfirm() {
    setSaving(true);
    const result = await updateAbsenceSubstitute(absence.id, selected);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
    } else {
      setSaved(true);
      setTimeout(onClose, 1200);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 z-40 animate-in fade-in duration-150"
        onClick={onClose}
      />

      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-white shadow-xl z-50 flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">Motor de Substituição</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Falta de <strong>{absence.collaborator_name}</strong>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Período */}
        <div className="px-5 py-3 bg-[var(--color-background)] border-b border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-muted)]">Período de ausência</p>
          <p className="text-sm font-medium text-[var(--color-text-main)] mt-0.5">
            {new Date(absence.starts_on + "T00:00:00").toLocaleDateString("pt-PT", { day: "2-digit", month: "long" })}
            {absence.starts_on !== absence.ends_on && (
              <> → {new Date(absence.ends_on + "T00:00:00").toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" })}</>
            )}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <p className="text-sm">A procurar substitutos disponíveis…</p>
            </div>
          ) : error ? (
            <div className="text-sm text-[var(--color-danger)] bg-red-50 rounded-lg px-4 py-3">
              {error}
            </div>
          ) : suggestions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
              <Users className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm text-center">Nenhum colaborador disponível neste período.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-[var(--color-text-muted)] mb-3">
                {suggestions.length} colaborador{suggestions.length !== 1 ? "es" : ""} disponível{suggestions.length !== 1 ? "eis" : ""}, ordenados por compatibilidade
              </p>

              {/* Opção: sem substituto */}
              <button
                onClick={() => setSelected(null)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
                  selected === null
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]"
                    : "border-[var(--color-border)] hover:bg-[var(--color-background)]"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <X className="w-3.5 h-3.5 text-gray-400" />
                </div>
                <span className="text-sm text-[var(--color-text-sub)]">Sem substituto</span>
              </button>

              {suggestions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
                    selected === s.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]"
                      : "border-[var(--color-border)] hover:bg-[var(--color-background)]"
                  }`}
                >
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0">
                    <span className="text-[var(--color-primary)] font-semibold text-xs">
                      {s.full_name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--color-text-main)]">{s.full_name}</span>
                      {selected === s.id && <CheckCircle2 className="w-4 h-4 text-[var(--color-primary)] shrink-0" />}
                    </div>

                    {/* Skills em comum */}
                    {s.skills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {s.skills.slice(0, 3).map((sk) => (
                          <span key={sk} className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)]">
                            {sk}
                          </span>
                        ))}
                        {s.skills.length > 3 && (
                          <span className="text-[10px] text-[var(--color-text-muted)]">+{s.skills.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Conflitos */}
                  {s.conflicting_services > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 shrink-0">
                      {s.conflicting_services} serv.
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-5 py-4">
          {saved ? (
            <div className="flex items-center justify-center gap-2 text-[var(--color-primary)] py-2">
              <CheckCircle2 className="w-4 h-4" />
              <span className="text-sm font-medium">Substituto confirmado!</span>
            </div>
          ) : (
            <button
              onClick={handleConfirm}
              disabled={saving || loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              <UserCheck className="w-4 h-4" />
              {selected ? "Confirmar substituto" : "Guardar sem substituto"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
