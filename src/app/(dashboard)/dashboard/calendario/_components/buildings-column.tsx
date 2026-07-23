"use client";

import { useEffect, useState } from "react";
import { GripVertical, Plus, Pencil, Trash2, X, Building2, MapPin, Users, Euro, FileText } from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BuildingCardWeekday } from "@/types/database";
import type { BuildingCard } from "@/app/actions/building-cards";
import {
  createBuildingCard, updateBuildingCard, deleteBuildingCard, reorderBuildingCards,
} from "@/app/actions/building-cards";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Team = { id: string; name: string; color: string };

interface BuildingsColumnProps {
  weekday: BuildingCardWeekday;
  cards: BuildingCard[];
  teams: Team[];
  onChanged: () => void;
  /** Largura mínima da coluna — igual às colunas de equipa (ver COLUMN_MIN_W em calendar-view.tsx). */
  minWidth: number;
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const NO_TEAM_COLOR = "#94A3B8";

interface CardFormState {
  name: string;
  address: string;
  teamId: string;
  notes: string;
}

function teamById(teams: Team[], id: string | null) {
  return id ? teams.find((t) => t.id === id) ?? null : null;
}

function SortableCard({
  card, teams, onOpen, onEdit, onDelete,
}: {
  card: BuildingCard;
  teams: Team[];
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id });
  const team = teamById(teams, card.team_id);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      onClick={onOpen}
      className="group bg-white rounded-lg border border-[var(--color-border)] px-2 py-2 shadow-sm overflow-hidden cursor-pointer hover:border-[var(--color-primary)]/40 transition-colors"
    >
      <div className="flex items-start gap-1.5 min-w-0">
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          title="Arrastar para reordenar"
          className="mt-0.5 shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)] cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-[var(--color-text-main)] break-words">{card.name}</p>
          {card.address && (
            <p className="text-[10px] text-[var(--color-text-muted)] truncate">{card.address}</p>
          )}
        </div>

        <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Editar" className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-sub)]">
            <Pencil className="w-3 h-3" />
          </button>
          <span onClick={(e) => e.stopPropagation()}>
            <ConfirmDialog
              trigger={
                <button title="Apagar" className="p-1 rounded text-[var(--color-text-muted)] hover:bg-red-50 hover:text-red-600">
                  <Trash2 className="w-3 h-3" />
                </button>
              }
              title="Apagar prédio"
              description={`Remover "${card.name}" da coluna Prédios? Esta ação não pode ser desfeita.`}
              confirmLabel="Apagar"
              onConfirm={onDelete}
            />
          </span>
        </div>
      </div>

      <div className="mt-1 min-w-0">
        <span
          className="block w-full px-1.5 py-0.5 rounded-md text-[10px] font-semibold text-white leading-snug break-words"
          style={{ backgroundColor: team?.color ?? NO_TEAM_COLOR }}
        >
          {team?.name ?? "Sem equipa"}
        </span>
        {card.monthly_value != null && (
          <span className="block text-[10px] font-semibold text-[var(--color-text-sub)] tabular-nums mt-0.5">
            {card.monthly_value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
          </span>
        )}
        {card.notes && (
          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5 truncate">
            {card.notes}
          </p>
        )}
      </div>
    </div>
  );
}

function BuildingDetailSheet({
  card, weekday, teams, initialEdit, onClose, onSaved, onDeleted,
}: {
  card: BuildingCard | null;
  weekday: BuildingCardWeekday;
  teams: Team[];
  initialEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const isNew = card === null;
  const [editing, setEditing] = useState(initialEdit || isNew);
  const [form, setForm] = useState<CardFormState>({
    name: card?.name ?? "",
    address: card?.address ?? "",
    teamId: card?.team_id ?? "",
    notes: card?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = teamById(teams, card?.team_id ?? null);

  async function handleSubmit() {
    if (!form.name.trim()) { setError("O nome do prédio é obrigatório."); return; }
    setSaving(true);
    setError(null);
    try {
      const result = card
        ? await updateBuildingCard(card.id, {
            name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
          })
        : await createBuildingCard({
            weekday, name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
          });

      if (!result.ok) { setError(result.error ?? "Erro ao guardar."); return; }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!card) return;
    const result = await deleteBuildingCard(card.id);
    if (!result.ok) { setError(result.error ?? "Erro ao apagar."); return; }
    onDeleted();
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h3 className="font-bold text-base text-[var(--color-text-main)]">
            {isNew ? "Novo prédio" : editing ? "Editar prédio" : "Prédio"}
          </h3>
          <button onClick={onClose} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Nome do prédio</label>
                <input
                  className={INPUT_CLS}
                  placeholder="Nome do prédio"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Morada</label>
                <input
                  className={INPUT_CLS}
                  placeholder="Morada (opcional)"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Equipa</label>
                <select
                  className={SELECT_CLS}
                  value={form.teamId}
                  onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
                >
                  <option value="">Sem equipa</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Notas</label>
                <input
                  className={INPUT_CLS}
                  placeholder="Notas (ex: chave, frequência)"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-lg font-bold text-[var(--color-text-main)]">{card!.name}</p>
              </div>
              {card!.address && (
                <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
                  <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span>{card!.address}</span>
                </div>
              )}
              <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
                <Users className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                <span
                  className="inline-block px-2 py-0.5 rounded-md text-xs font-semibold text-white"
                  style={{ backgroundColor: team?.color ?? NO_TEAM_COLOR }}
                >
                  {team?.name ?? "Sem equipa"}
                </span>
              </div>
              {card!.monthly_value != null && (
                <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
                  <Euro className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span>{card!.monthly_value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })} / mês</span>
                </div>
              )}
              {card!.notes && (
                <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
                  <FileText className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span>{card!.notes}</span>
                </div>
              )}
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end px-5 py-4 border-t border-[var(--color-border)]">
          {editing ? (
            <>
              <button onClick={isNew ? onClose : () => setEditing(false)} disabled={saving}
                className="px-4 py-2 text-sm font-medium rounded-xl border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
                Cancelar
              </button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-2 text-sm font-medium rounded-xl bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {saving ? "A guardar..." : "Guardar"}
              </button>
            </>
          ) : (
            <>
              <ConfirmDialog
                trigger={
                  <button className="px-4 py-2 text-sm font-medium rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition-colors">
                    Apagar
                  </button>
                }
                title="Apagar prédio"
                description={`Remover "${card!.name}" da coluna Prédios? Esta ação não pode ser desfeita.`}
                confirmLabel="Apagar"
                onConfirm={handleDelete}
              />
              <button onClick={() => setEditing(true)}
                className="px-4 py-2 text-sm font-medium rounded-xl bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors">
                Editar
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function BuildingsColumn({ weekday, cards, teams, onChanged, minWidth }: BuildingsColumnProps) {
  const [localCards, setLocalCards] = useState(cards);
  const [sheetState, setSheetState] = useState<{ card: BuildingCard | null; edit: boolean } | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza a lista otimista local com a prop do servidor, mesmo padrão de localServices em calendar-view.tsx
  useEffect(() => { setLocalCards(cards); }, [cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function handleDelete(id: string) {
    setLocalCards((curr) => curr.filter((c) => c.id !== id));
    const result = await deleteBuildingCard(id);
    if (!result.ok) setLocalCards(cards);
    onChanged();
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localCards.findIndex((c) => c.id === active.id);
    const newIndex = localCards.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(localCards, oldIndex, newIndex);
    setLocalCards(reordered);

    const result = await reorderBuildingCards(weekday, reordered.map((c) => c.id));
    if (!result.ok) setLocalCards(cards);
    onChanged();
  }

  return (
    <div className="flex-1 flex flex-col h-full border-l border-[var(--color-border)] bg-[var(--color-background)]/40" style={{ minWidth: `${minWidth}px` }}>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2">
        {localCards.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <Building2 className="w-6 h-6 text-[var(--color-text-muted)]" />
            <p className="text-xs text-[var(--color-text-muted)]">Sem prédios para este dia.</p>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={localCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {localCards.map((card) => (
                <SortableCard
                  key={card.id}
                  card={card}
                  teams={teams}
                  onOpen={() => setSheetState({ card, edit: false })}
                  onEdit={() => setSheetState({ card, edit: true })}
                  onDelete={() => handleDelete(card.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <button
        onClick={() => setSheetState({ card: null, edit: true })}
        className="shrink-0 flex items-center justify-center gap-1.5 m-2 mt-0 px-2 py-1.5 rounded-lg border border-dashed border-[var(--color-border)] text-[11px] font-medium text-[var(--color-text-sub)] hover:bg-white hover:border-[var(--color-primary)] transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Adicionar prédio
      </button>

      {sheetState && (
        <BuildingDetailSheet
          card={sheetState.card}
          weekday={weekday}
          teams={teams}
          initialEdit={sheetState.edit}
          onClose={() => setSheetState(null)}
          onSaved={() => { setSheetState(null); onChanged(); }}
          onDeleted={() => { setSheetState(null); onChanged(); }}
        />
      )}
    </div>
  );
}
