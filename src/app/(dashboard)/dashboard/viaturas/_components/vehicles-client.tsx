"use client";

import { useState } from "react";
import { Car, Plus, Pencil, Trash2, Loader2, X, AlertCircle } from "lucide-react";
import {
  createVehicle,
  updateVehicle,
  deleteVehicle,
  type Vehicle,
  type VehicleStatus,
} from "@/app/actions/vehicles";

// ─── Constantes ───────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<VehicleStatus, string> = {
  ativo:       "Ativo",
  manutencao:  "Manutenção",
  inativo:     "Inativo",
};

const STATUS_COLORS: Record<VehicleStatus, string> = {
  ativo:      "bg-green-100 text-green-700",
  manutencao: "bg-amber-100 text-amber-700",
  inativo:    "bg-gray-100 text-gray-500",
};

// ─── Sheet criar/editar ───────────────────────────────────────────────────────

interface SheetProps {
  vehicle?: Vehicle | null;
  onClose: () => void;
  onSaved: () => void;
}

function VehicleSheet({ vehicle, onClose, onSaved }: SheetProps) {
  const [model,  setModel]  = useState(vehicle?.model  ?? "");
  const [plate,  setPlate]  = useState(vehicle?.plate  ?? "");
  const [status, setStatus] = useState<VehicleStatus>(vehicle?.status ?? "ativo");
  const [notes,  setNotes]  = useState(vehicle?.notes  ?? "");
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!model.trim() || !plate.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (vehicle) {
        await updateVehicle(vehicle.id, { model, plate, status, notes: notes || null });
      } else {
        await createVehicle({ model, plate, status, notes });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao guardar";
      setError(msg.includes("unique") ? "Já existe uma viatura com essa matrícula." : msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-base font-semibold text-[var(--color-text-main)]">
            {vehicle ? "Editar viatura" : "Nova viatura"}
          </h2>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Modelo <span className="text-red-500">*</span>
            </label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="ex: Opel Vivaro"
              required
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">
              Matrícula <span className="text-red-500">*</span>
            </label>
            <input
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder="ex: AA-00-BB"
              required
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Estado</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as VehicleStatus)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            >
              {(Object.keys(STATUS_LABELS) as VehicleStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Observações</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Notas adicionais..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-4 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
            Cancelar
          </button>
          <button
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
            disabled={saving || !model.trim() || !plate.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {vehicle ? "Guardar" : "Criar viatura"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  initialVehicles: Vehicle[];
}

export function VehiclesClient({ initialVehicles }: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[]>(initialVehicles);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = vehicles.filter((v) =>
    v.model.toLowerCase().includes(search.toLowerCase()) ||
    v.plate.toLowerCase().includes(search.toLowerCase()),
  );

  async function handleDelete(id: string) {
    if (!confirm("Eliminar esta viatura?")) return;
    setDeleting(id);
    try {
      await deleteVehicle(id);
      setVehicles((prev) => prev.filter((v) => v.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  function handleSaved() {
    // Revalidation via server action — reload vehicles from server
    window.location.reload();
  }

  return (
    <div className="space-y-6">
      {/* Acções */}
      <div className="flex items-center justify-end gap-4 flex-wrap">
        <button
          onClick={() => { setEditing(null); setSheetOpen(true); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nova viatura
        </button>
      </div>

      {/* Pesquisa + resumo */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pesquisar modelo ou matrícula..."
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
        />
        <div className="flex gap-2 text-xs text-[var(--color-text-muted)]">
          {(Object.keys(STATUS_LABELS) as VehicleStatus[]).map((s) => {
            const count = vehicles.filter((v) => v.status === s).length;
            return (
              <span key={s} className={`px-2 py-1 rounded-full font-medium ${STATUS_COLORS[s]}`}>
                {count} {STATUS_LABELS[s].toLowerCase()}{count !== 1 ? "s" : ""}
              </span>
            );
          })}
        </div>
      </div>

      {/* Tabela */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center text-[var(--color-text-muted)] text-sm">
          {search ? "Sem resultados para a pesquisa." : "Sem viaturas registadas. Cria a primeira!"}
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Modelo</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Matrícula</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Estado</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Observações</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {filtered.map((v) => (
                <tr key={v.id} className="bg-white hover:bg-[var(--color-background)] transition-colors">
                  <td className="px-4 py-3 font-medium text-[var(--color-text-main)]">
                    <div className="flex items-center gap-2">
                      <Car className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                      {v.model}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-[var(--color-text-sub)]">{v.plate}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[v.status]}`}>
                      {STATUS_LABELS[v.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-text-muted)] max-w-[200px] truncate">
                    {v.notes ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => { setEditing(v); setSheetOpen(true); }}
                        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
                        title="Editar"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(v.id)}
                        disabled={deleting === v.id}
                        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                        title="Eliminar"
                      >
                        {deleting === v.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sheet */}
      {sheetOpen && (
        <VehicleSheet
          vehicle={editing}
          onClose={() => setSheetOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
