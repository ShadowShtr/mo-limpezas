"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Calendar, Loader2, Pencil, Plus, Trash2, User, X } from "lucide-react";
import {
  createManagementTask,
  deleteManagementTask,
  saveKanbanColumns,
  updateManagementTask,
  type KanbanColumn,
  type ManagementTask,
  type TaskInput,
  type TaskPriority,
} from "@/app/actions/management-tasks";

// ── Color palette ─────────────────────────────────────────────────────────────
const COLOR_DOT: Record<string, string> = {
  amber: "bg-amber-400", blue: "bg-blue-400", green: "bg-green-400",
  purple: "bg-purple-400", red: "bg-red-400", slate: "bg-slate-400",
  pink: "bg-pink-400", indigo: "bg-indigo-400",
};
const COLOR_BORDER: Record<string, string> = {
  amber: "border-l-amber-400", blue: "border-l-blue-400", green: "border-l-green-400",
  purple: "border-l-purple-400", red: "border-l-red-400", slate: "border-l-slate-400",
  pink: "border-l-pink-400", indigo: "border-l-indigo-400",
};
const COLOR_TAG: Record<string, string> = {
  amber: "bg-amber-100 text-amber-700", blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700", purple: "bg-purple-100 text-purple-700",
  red: "bg-red-100 text-red-700", slate: "bg-slate-100 text-slate-600",
  pink: "bg-pink-100 text-pink-700", indigo: "bg-indigo-100 text-indigo-700",
};
const PALETTE = Object.keys(COLOR_DOT);

// ── Types ─────────────────────────────────────────────────────────────────────
interface Assignee { id: string; full_name: string; }

interface Props {
  initialTasks: ManagementTask[];
  initialColumns: KanbanColumn[];
  companyId: string;
  members: Assignee[];
}

type DragState = {
  taskId: string;
  fromColumnId: string;
  startX: number; startY: number;
  x: number; y: number;
  active: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(s: string | null) {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = d < today;
  return { label: d.toLocaleDateString("pt-PT"), overdue };
}

// ── Card component ────────────────────────────────────────────────────────────
function TaskCard({
  task, column, deleting, dragging,
  onDelete, onPointerDown, onClick,
}: {
  task: ManagementTask;
  column: KanbanColumn;
  deleting: boolean;
  dragging: boolean;
  onDelete: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
}) {
  const due = fmtDate(task.due_date);
  return (
    <div
      className={`bg-white rounded-xl border border-[var(--color-border)] border-l-4 ${COLOR_BORDER[column.color] ?? "border-l-slate-300"} p-3.5 space-y-2.5 shadow-sm cursor-pointer select-none transition-all ${
        dragging ? "opacity-40 scale-95" : "hover:shadow-md hover:border-[var(--color-primary)]/30"
      } ${task.priority === "urgente" ? "" : ""}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--color-text-main)] leading-snug flex-1">
          {task.title}
        </p>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          disabled={deleting}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
        >
          {deleting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {task.body && (
        <p className="text-xs text-[var(--color-text-sub)] leading-relaxed line-clamp-2">{task.body}</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {task.priority === "urgente" && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
            <AlertTriangle className="w-3 h-3" />Urgente
          </span>
        )}
        {due && (
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${due.overdue ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"}`}>
            <Calendar className="w-3 h-3" />{due.label}
          </span>
        )}
        {task.assigned_to_name && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium">
            <User className="w-3 h-3" />{task.assigned_to_name}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function TasksClient({ initialTasks, initialColumns, companyId, members }: Props) {
  const [tasks, setTasks] = useState(initialTasks);
  const [columns, setColumns] = useState(initialColumns);

  // Transitions
  const [savingColumns, startSaveColumns] = useTransition();
  const [creating, startCreate] = useTransition();
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Detail popup
  const [openTask, setOpenTask] = useState<ManagementTask | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editPriority, setEditPriority] = useState<TaskPriority>("normal");
  const [editAssigned, setEditAssigned] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [savingDetail, startSaveDetail] = useTransition();

  // New task form per column
  const [addingTask, setAddingTask] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Add column form
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [newColColor, setNewColColor] = useState("blue");

  // Edit column name inline
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState("");

  // Drag state
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const columnRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const actionsRef = useRef({ moving, setMoving, setTasks });
  const wasDraggingRef = useRef(false);

  // Keep actionsRef fresh
  useEffect(() => {
    actionsRef.current = { moving, setMoving, setTasks };
  }, [moving]);

  // Global pointer events for drag
  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      const active = d.active || Math.sqrt(dx * dx + dy * dy) > 8;
      if (active) {
        let found: string | null = null;
        for (const [id, el] of columnRefs.current) {
          const r = el.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            found = id; break;
          }
        }
        dropTargetRef.current = found;
        setDropTarget(found);
      }
      const next: DragState = { ...d, x: e.clientX, y: e.clientY, active };
      dragRef.current = next;
      setDrag(next);
    }

    async function handleUp() {
      const d = dragRef.current;
      if (!d) return;
      wasDraggingRef.current = d.active;
      if (d.active && dropTargetRef.current && dropTargetRef.current !== d.fromColumnId) {
        const toCol = dropTargetRef.current;
        setMoving(d.taskId);
        setTasks((prev) => prev.map((t) => t.id === d.taskId ? { ...t, status: toCol } : t));
        await updateManagementTask(d.taskId, { status: toCol });
        setMoving(null);
      }
      dragRef.current = null;
      dropTargetRef.current = null;
      setDrag(null);
      setDropTarget(null);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  function handleCardPointerDown(e: React.PointerEvent, taskId: string, columnId: string) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const state: DragState = { taskId, fromColumnId: columnId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false };
    dragRef.current = state;
    setDrag(state);
  }

  function handleCardClick(task: ManagementTask) {
    if (wasDraggingRef.current) { wasDraggingRef.current = false; return; }
    setOpenTask(task);
    setEditTitle(task.title);
    setEditBody(task.body ?? "");
    setEditPriority(task.priority as TaskPriority);
    setEditAssigned(task.assigned_to ?? "");
    setEditDue(task.due_date ?? "");
    setEditStatus(task.status);
  }

  function saveDetail() {
    if (!openTask) return;
    startSaveDetail(async () => {
      const update: Partial<TaskInput> = {
        title: editTitle.trim() || openTask.title,
        body: editBody.trim() || null,
        priority: editPriority,
        assigned_to: editAssigned || null,
        due_date: editDue || null,
        status: editStatus,
      };
      await updateManagementTask(openTask.id, update);
      setTasks((prev) => prev.map((t) => t.id === openTask.id ? {
        ...t,
        ...update,
        assigned_to_name: members.find((m) => m.id === editAssigned)?.full_name ?? null,
      } : t));
      setOpenTask(null);
    });
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    const res = await deleteManagementTask(id);
    if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== id));
    setDeleting(null);
  }

  function handleCreateTask(columnId: string) {
    if (!newTitle.trim()) { setCreateError("O título é obrigatório"); return; }
    setCreateError(null);
    const input: TaskInput = { title: newTitle.trim(), status: columnId };
    startCreate(async () => {
      const res = await createManagementTask(companyId, input);
      if (!res.ok) { setCreateError(res.error ?? "Erro"); return; }
      const fake: ManagementTask = {
        id: `temp-${Date.now()}`, title: input.title, body: null,
        status: columnId, priority: "normal", assigned_to: null,
        assigned_to_name: null, created_by: null, created_by_name: null,
        due_date: null, completed_at: null, created_at: new Date().toISOString(),
      };
      setTasks((prev) => [fake, ...prev]);
      setAddingTask(null);
      setNewTitle("");
    });
  }

  function persistColumns(next: KanbanColumn[]) {
    setColumns(next);
    startSaveColumns(async () => { await saveKanbanColumns(companyId, next); });
  }

  function commitAddColumn() {
    const name = newColName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    persistColumns([...columns, { id, name, color: newColColor }]);
    setAddingColumn(false);
    setNewColName("");
    setNewColColor("blue");
  }

  function commitRenameColumn(id: string) {
    const name = editingColName.trim();
    if (name) persistColumns(columns.map((c) => c.id === id ? { ...c, name } : c));
    setEditingColId(null);
  }

  function handleDeleteColumn(col: KanbanColumn) {
    const hasTask = tasks.some((t) => t.status === col.id);
    if (hasTask) { alert(`Mova ou elimine todas as tarefas de "${col.name}" antes de apagar.`); return; }
    if (!confirm(`Eliminar coluna "${col.name}"?`)) return;
    persistColumns(columns.filter((c) => c.id !== col.id));
  }

  const draggedTask = drag ? tasks.find((t) => t.id === drag.taskId) : null;
  const draggedColumn = drag ? columns.find((c) => c.id === drag.fromColumnId) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-text-muted)]">
          {savingColumns && <span className="italic">A guardar colunas...</span>}
        </p>
        <button
          onClick={() => { setNewColName(""); setNewColColor("blue"); setAddingColumn(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Nova coluna
        </button>
      </div>

      {/* Board */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minWidth: "max-content" }}>
        {columns.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id);
          const isDropTarget = dropTarget === col.id && drag?.fromColumnId !== col.id;
          return (
            <div
              key={col.id}
              ref={(el) => {
                if (el) columnRefs.current.set(col.id, el);
                else columnRefs.current.delete(col.id);
              }}
              className={`flex flex-col w-72 flex-shrink-0 rounded-xl border transition-colors ${
                isDropTarget
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/40"
                  : "border-[var(--color-border)] bg-[var(--color-background)]"
              }`}
            >
              {/* Column header */}
              <div className={`flex items-center gap-2 px-4 py-3 bg-white rounded-t-xl border-b border-[var(--color-border)] border-l-4 ${COLOR_BORDER[col.color] ?? "border-l-slate-300"}`}>
                {editingColId === col.id ? (
                  <input
                    autoFocus
                    className="flex-1 text-sm font-semibold bg-transparent border-b border-[var(--color-primary)] outline-none pb-0.5"
                    value={editingColName}
                    onChange={(e) => setEditingColName(e.target.value)}
                    onBlur={() => commitRenameColumn(col.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRenameColumn(col.id);
                      if (e.key === "Escape") setEditingColId(null);
                    }}
                  />
                ) : (
                  <button
                    className="flex-1 text-left text-sm font-semibold text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors"
                    onClick={() => { setEditingColId(col.id); setEditingColName(col.name); }}
                  >
                    {col.name}
                  </button>
                )}
                <span className="text-xs bg-[var(--color-background)] text-[var(--color-text-muted)] px-2 py-0.5 rounded-full font-medium min-w-[20px] text-center">
                  {colTasks.length}
                </span>
                <button
                  className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors"
                  onClick={() => handleDeleteColumn(col)}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Tasks */}
              <div className="flex-1 p-3 space-y-2 min-h-[120px]">
                {colTasks.length === 0 && !isDropTarget && (
                  <div className="flex items-center justify-center py-8 rounded-lg border-2 border-dashed border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-muted)]">Sem tarefas</p>
                  </div>
                )}
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    column={col}
                    deleting={deleting === task.id}
                    dragging={drag?.taskId === task.id && !!drag.active}
                    onDelete={() => handleDelete(task.id)}
                    onPointerDown={(e) => handleCardPointerDown(e, task.id, col.id)}
                    onClick={() => handleCardClick(task)}
                  />
                ))}
              </div>

              {/* Add task inline */}
              <div className="px-3 pb-3">
                {addingTask === col.id ? (
                  <div className="space-y-1.5">
                    <input
                      autoFocus
                      className="w-full px-3 py-2 border border-[var(--color-primary)] rounded-lg text-sm outline-none"
                      placeholder="Título da tarefa..."
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateTask(col.id);
                        if (e.key === "Escape") { setAddingTask(null); setNewTitle(""); }
                      }}
                      onBlur={() => { if (!newTitle.trim()) { setAddingTask(null); setNewTitle(""); } }}
                    />
                    {createError && <p className="text-xs text-red-600">{createError}</p>}
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleCreateTask(col.id)}
                        disabled={creating}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-medium disabled:opacity-50"
                      >
                        {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Adicionar
                      </button>
                      <button
                        onClick={() => { setAddingTask(null); setNewTitle(""); }}
                        className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-sub)]"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAddingTask(col.id); setNewTitle(""); setCreateError(null); }}
                    className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg text-xs text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-text-sub)] transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Adicionar tarefa
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Add column form */}
        {addingColumn && (
          <div className="flex flex-col w-72 flex-shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-3">
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Nova coluna</p>
            <input
              autoFocus
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
              placeholder="Nome da coluna..."
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAddColumn();
                if (e.key === "Escape") setAddingColumn(false);
              }}
            />
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Cor</p>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColColor(c)}
                    className={`w-6 h-6 rounded-full ${COLOR_DOT[c]} ring-offset-1 transition-all ${newColColor === c ? "ring-2 ring-[var(--color-primary)]" : ""}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={commitAddColumn}
                className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium"
              >
                Criar
              </button>
              <button
                onClick={() => setAddingColumn(false)}
                className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)]"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Drag ghost */}
      {drag?.active && draggedTask && draggedColumn && typeof window !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-64 rotate-2 rounded-xl border border-[var(--color-primary)] bg-white p-3.5 shadow-2xl opacity-90"
          style={{ left: drag.x - 32, top: drag.y - 20 }}
        >
          <p className="text-sm font-semibold text-[var(--color-text-main)] leading-snug">{draggedTask.title}</p>
          {draggedTask.body && (
            <p className="mt-1 text-xs text-[var(--color-text-sub)] line-clamp-2">{draggedTask.body}</p>
          )}
        </div>,
        document.body,
      )}

      {/* Task detail popup */}
      {openTask && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={saveDetail} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Detalhes da tarefa</h2>
              <div className="flex gap-2">
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => { handleDelete(openTask.id); setOpenTask(null); }}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button onClick={saveDetail} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)]">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Título</label>
                <input
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Descrição</label>
                <textarea
                  rows={3}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)] resize-none"
                  placeholder="Detalhes adicionais..."
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Coluna</label>
                  <select
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value)}
                  >
                    {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Prioridade</label>
                  <select
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
                  >
                    <option value="normal">Normal</option>
                    <option value="urgente">Urgente</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Data limite</label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                    value={editDue}
                    onChange={(e) => setEditDue(e.target.value)}
                  />
                </div>
                {members.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Atribuir a</label>
                    <select
                      className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                      value={editAssigned}
                      onChange={(e) => setEditAssigned(e.target.value)}
                    >
                      <option value="">— Ninguém —</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <button
              onClick={saveDetail}
              disabled={savingDetail}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {savingDetail ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Guardar
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
