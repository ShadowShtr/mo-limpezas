"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus, Pencil, Trash2, X } from "lucide-react";
import {
  createBuildingCard, updateBuildingCard, deleteBuildingCard, type BuildingCard,
} from "@/app/actions/building-cards";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { BuildingCardWeekday } from "@/types/database";

type Team = { id: string; name: string; color: string };

interface Props {
  buildingCards: BuildingCard[];
  teams: Team[];
}

const WEEKDAY_LABELS: Record<BuildingCardWeekday, string> = {
  mon: "2ª feira", tue: "3ª feira", wed: "4ª feira", thu: "5ª feira",
  fri: "6ª feira", sat: "Sábado", sun: "Domingo",
};
const WEEKDAY_ORDER: BuildingCardWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";
const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

interface FormState {
  name: string;
  address: string;
  weekday: BuildingCardWeekday;
  teamId: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: "", address: "", weekday: "mon", teamId: "", notes: "" };

export function PrediosTable({ buildingCards, teams }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = buildingCards.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.address ?? "").toLowerCase().includes(search.toLowerCase()),
  );
  const sorted = [...filtered].sort((a, b) => {
    const dOrder = WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday);
    return dOrder !== 0 ? dOrder : a.sort_order - b.sort_order;
  });

  function teamById(id: string | null) {
    return id ? teams.find((t) => t.id === id) ?? null : null;
  }

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError(null);
  }

  function openEditForm(card: BuildingCard) {
    setEditingId(card.id);
    setForm({
      name: card.name, address: card.address ?? "", weekday: card.weekday,
      teamId: card.team_id ?? "", notes: card.notes ?? "",
    });
    setShowForm(true);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function handleSubmit() {
    if (!form.name.trim()) { setError("O nome do prédio é obrigatório."); return; }
    setSaving(true);
    setError(null);
    try {
      const result = editingId
        ? await updateBuildingCard(editingId, {
            name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
          })
        : await createBuildingCard({
            weekday: form.weekday, name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
          });

      if (!result.ok) { setError(result.error ?? "Erro ao guardar."); return; }
      closeForm();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(card: BuildingCard) {
    const result = await deleteBuildingCard(card.id);
    if (!result.ok) { window.alert(result.error ?? "Erro ao apagar."); return; }
    router.refresh();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar prédio..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white
                       text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
        </div>
        <button
          onClick={openCreateForm}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Novo prédio
        </button>
      </div>

      {showForm && (
        <div className="p-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-[var(--color-text-main)]">
              {editingId ? "Editar prédio" : "Novo prédio"}
            </span>
            <button onClick={closeForm} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input className={INPUT_CLS} placeholder="Nome do prédio" value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
            <input className={INPUT_CLS} placeholder="Morada (opcional)" value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            <select className={SELECT_CLS} value={form.weekday} disabled={!!editingId}
              onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value as BuildingCardWeekday }))}>
              {WEEKDAY_ORDER.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}
            </select>
            <select className={SELECT_CLS} value={form.teamId}
              onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}>
              <option value="">Sem equipa</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input className={`${INPUT_CLS} sm:col-span-2`} placeholder="Notas (ex: chave, frequência de limpeza)" value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 justify-end mt-3">
            <button onClick={closeForm} disabled={saving}
              className="px-3 py-2 text-sm font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-white">
              Cancelar
            </button>
            <button onClick={handleSubmit} disabled={saving}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
              {saving ? "A guardar..." : "Guardar"}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Prédio</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Dia</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Equipa</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Notas</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
                  Sem prédios registados.
                </td>
              </tr>
            ) : sorted.map((card) => {
              const team = teamById(card.team_id);
              return (
                <tr key={card.id} className="hover:bg-[var(--color-background)]/50">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--color-text-main)]">{card.name}</p>
                    {card.address && <p className="text-xs text-[var(--color-text-muted)]">{card.address}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{WEEKDAY_LABELS[card.weekday]}</td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: team?.color ?? "#94A3B8" }}
                    >
                      {team?.name ?? "Sem equipa"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-text-muted)] max-w-[220px] truncate">{card.notes}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEditForm(card)} title="Editar"
                        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-sub)]">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <ConfirmDialog
                        trigger={
                          <button title="Apagar" className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        }
                        title="Apagar prédio"
                        description={`Remover "${card.name}" da lista de prédios? Esta ação não pode ser desfeita.`}
                        confirmLabel="Apagar"
                        onConfirm={() => handleDelete(card)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
