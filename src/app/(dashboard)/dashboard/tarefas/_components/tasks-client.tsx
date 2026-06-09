"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Calendar, Loader2, Plus, Trash2, User, X } from "lucide-react";
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

// ── Color palette ──────────────────────────────────────────────────────────────
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
const COLOR_HEAD: Record<string, string> = {
  amber: "border-t-amber-400", blue: "border-t-blue-400", green: "border-t-green-400",
  purple: "border-t-purple-400", red: "border-t-red-400", slate: "border-t-slate-400",
  pink: "border-t-pink-400", indigo: "border-t-indigo-400",
};
const PALETTE = Object.keys(COLOR_DOT);

// ── Types ──────────────────────────────────────────────────────────────────────
interface Assignee { id: string; full_name: string; }

interface Props {
  initialTasks: ManagementTask[];
  initialColumns: KanbanColumn[];
  companyId: string;
  members: Assignee[];
}

type DragState = {
  taskId: string; fromColumnId: string;
  startX: number; startY: number; x: number; y: number; active: boolean;
};

// ── Helper ─────────────────────────────────────────────────────────────────────
function fmtDate(s: string | null) {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return { label: d.toLocaleDateString("pt-PT"), overdue: d < today };
}

// ── Card ───────────────────────────────────────────────────────────────────────
function TaskCard({ task, column, deleting, dragging, onDelete, onPointerDown, onClick }: {
  task: ManagementTask; column: KanbanColumn;
  deleting: boolean; dragging: boolean;
  onDelete: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
}) {
  const due = fmtDate(task.due_date);
  return (
    <div
      className={`bg-white rounded-xl border border-[var(--color-border)] border-l-4 ${COLOR_BORDER[column.color] ?? "border-l-slate-300"} p-3.5 space-y-2 shadow-sm cursor-pointer select-none transition-all ${
        dragging ? "opacity-40 scale-95" : "hover:shadow-md"
      }`}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--color-text-main)] leading-snug flex-1">{task.title}</p>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          disabled={deleting}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
      {task.body && <p className="text-xs text-[var(--color-text-sub)] line-clamp-2 leading-relaxed">{task.body}</p>}
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

// ── Main ───────────────────────────────────────────────────────────────────────
export function TasksClient({ initialTasks, initialColumns, companyId, members }: Props) {
  const [tasks, setTasks] = useState(initialTasks);
  const [columns, setColumns] = useState(initialColumns);

  const [savingColumns, startSaveColumns] = useTransition();
  const [creating, startCreate] = useTransition();
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // ── "Nova tarefa" modal (top-level, com seletor de coluna) ──
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createColId, setCreateColId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createPriority, setCreatePriority] = useState<TaskPriority>("normal");
  const [createAssigned, setCreateAssigned] = useState("");
  const [createDue, setCreateDue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Inline "Adicionar tarefa" por coluna ──
  const [addingTaskCol, setAddingTaskCol] = useState<string | null>(null);
  const [inlineTitle, setInlineTitle] = useState("");

  // ── Detail popup ──
  const [openTask, setOpenTask] = useState<ManagementTask | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editPriority, setEditPriority] = useState<TaskPriority>("normal");
  const [editAssigned, setEditAssigned] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [savingDetail, startSaveDetail] = useTransition();

  // ── Nova coluna ──
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [newColColor, setNewColColor] = useState("blue");

  // ── Rename coluna ──
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState("");

  // ── Drag ──
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const columnRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const wasDraggingRef = useRef(false);

  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const d = dragRef.current; if (!d) return;
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      const active = d.active || Math.sqrt(dx * dx + dy * dy) > 8;
      if (active) {
        let found: string | null = null;
        for (const [id, el] of columnRefs.current) {
          const r = el.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { found = id; break; }
        }
        dropTargetRef.current = found;
        setDropTarget(found);
      }
      const next: DragState = { ...d, x: e.clientX, y: e.clientY, active };
      dragRef.current = next; setDrag(next);
    }
    async function handleUp() {
      const d = dragRef.current; if (!d) return;
      wasDraggingRef.current = d.active;
      if (d.active && dropTargetRef.current && dropTargetRef.current !== d.fromColumnId) {
        const toCol = dropTargetRef.current;
        setMoving(d.taskId);
        setTasks((prev) => prev.map((t) => t.id === d.taskId ? { ...t, status: toCol } : t));
        await updateManagementTask(d.taskId, { status: toCol });
        setMoving(null);
      }
      dragRef.current = null; dropTargetRef.current = null; setDrag(null); setDropTarget(null);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => { window.removeEventListener("pointermove", handleMove); window.removeEventListener("pointerup", handleUp); };
  }, []);

  function handleCardPointerDown(e: React.PointerEvent, taskId: string, columnId: string) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const state: DragState = { taskId, fromColumnId: columnId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false };
    dragRef.current = state; setDrag(state);
  }

  function handleCardClick(task: ManagementTask) {
    if (wasDraggingRef.current) { wasDraggingRef.current = false; return; }
    setOpenTask(task); setEditTitle(task.title); setEditBody(task.body ?? "");
    setEditPriority(task.priority as TaskPriority); setEditAssigned(task.assigned_to ?? "");
    setEditDue(task.due_date ?? ""); setEditStatus(task.status);
  }

  function saveDetail() {
    if (!openTask) return;
    startSaveDetail(async () => {
      const update: Partial<TaskInput> = {
        title: editTitle.trim() || openTask.title, body: editBody.trim() || null,
        priority: editPriority, assigned_to: editAssigned || null,
        due_date: editDue || null, status: editStatus,
      };
      await updateManagementTask(openTask.id, update);
      setTasks((prev) => prev.map((t) => t.id === openTask.id ? {
        ...t, ...update,
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
    if (openTask?.id === id) setOpenTask(null);
  }

  function submitCreateModal() {
    if (!createTitle.trim()) { setCreateError("O título é obrigatório"); return; }
    if (!createColId) { setCreateError("Selecione uma coluna"); return; }
    setCreateError(null);
    const input: TaskInput = {
      title: createTitle.trim(), body: createBody.trim() || null,
      priority: createPriority, assigned_to: createAssigned || null,
      due_date: createDue || null, status: createColId,
    };
    startCreate(async () => {
      const res = await createManagementTask(companyId, input);
      if (!res.ok) { setCreateError(res.error ?? "Erro ao criar tarefa"); return; }
      const fake: ManagementTask = {
        id: `temp-${Date.now()}`, title: input.title, body: input.body ?? null,
        status: createColId, priority: input.priority ?? "normal",
        assigned_to: input.assigned_to ?? null,
        assigned_to_name: members.find((m) => m.id === createAssigned)?.full_name ?? null,
        created_by: null, created_by_name: null,
        due_date: input.due_date ?? null, completed_at: null, created_at: new Date().toISOString(),
      };
      setTasks((prev) => [fake, ...prev]);
      setShowCreateModal(false);
      setCreateTitle(""); setCreateBody(""); setCreatePriority("normal"); setCreateAssigned(""); setCreateDue(""); setCreateColId("");
    });
  }

  function submitInlineTask(colId: string) {
    const title = inlineTitle.trim(); if (!title) { setAddingTaskCol(null); return; }
    startCreate(async () => {
      await createManagementTask(companyId, { title, status: colId });
      const fake: ManagementTask = {
        id: `temp-${Date.now()}`, title, body: null, status: colId, priority: "normal",
        assigned_to: null, assigned_to_name: null, created_by: null, created_by_name: null,
        due_date: null, completed_at: null, created_at: new Date().toISOString(),
      };
      setTasks((prev) => [...prev, fake]);
      setAddingTaskCol(null); setInlineTitle("");
    });
  }

  function persistColumns(next: KanbanColumn[]) {
    setColumns(next);
    startSaveColumns(async () => { await saveKanbanColumns(companyId, next); });
  }

  function commitAddColumn() {
    const name = newColName.trim(); if (!name) return;
    persistColumns([...columns, { id: crypto.randomUUID(), name, color: newColColor }]);
    setAddingColumn(false); setNewColName(""); setNewColColor("blue");
  }

  function commitRenameColumn(id: string) {
    const name = editingColName.trim();
    if (name) persistColumns(columns.map((c) => c.id === id ? { ...c, name } : c));
    setEditingColId(null);
  }

  function handleDeleteColumn(col: KanbanColumn) {
    if (tasks.some((t) => t.status === col.id)) { alert(`Mova ou elimine todas as tarefas de "${col.name}" antes de apagar.`); return; }
    if (!confirm(`Eliminar coluna "${col.name}"?`)) return;
    persistColumns(columns.filter((c) => c.id !== col.id));
  }

  const draggedTask = drag ? tasks.find((t) => t.id === drag.taskId) : null;
  const draggedColumn = drag ? columns.find((c) => c.id === drag.fromColumnId) : null;

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ── */}
      <div className="flex items-center justify-end gap-2 mb-4 flex-shrink-0">
        {savingColumns && <span className="text-xs text-[var(--color-text-muted)] italic mr-auto">A guardar...</span>}
        <button
          onClick={() => { setAddingColumn(true); setNewColName(""); setNewColColor("blue"); }}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
        >
          <Plus className="w-4 h-4" />Nova coluna
        </button>
        <button
          onClick={() => {
            setCreateColId(columns[0]?.id ?? "");
            setCreateTitle(""); setCreateBody(""); setCreatePriority("normal"); setCreateAssigned(""); setCreateDue(""); setCreateError(null);
            setShowCreateModal(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />Nova tarefa
        </button>
      </div>

      {/* ── Board ── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex gap-3 h-full pb-4" style={{ minWidth: "max-content", minHeight: 500 }}>

          {columns.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col.id);
            const isDropTarget = dropTarget === col.id && drag?.fromColumnId !== col.id;
            return (
              <div
                key={col.id}
                ref={(el) => { if (el) columnRefs.current.set(col.id, el); else columnRefs.current.delete(col.id); }}
                className={`flex flex-col w-[272px] flex-shrink-0 rounded-xl border-t-4 border border-[var(--color-border)] transition-colors ${COLOR_HEAD[col.color] ?? "border-t-slate-300"} ${
                  isDropTarget ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/30" : "bg-[var(--color-background)]"
                }`}
                style={{ maxHeight: "calc(100vh - 220px)" }}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2.5 bg-white rounded-t-lg border-b border-[var(--color-border)] flex-shrink-0">
                  {editingColId === col.id ? (
                    <input
                      autoFocus
                      className="flex-1 text-sm font-semibold bg-transparent border-b border-[var(--color-primary)] outline-none"
                      value={editingColName}
                      onChange={(e) => setEditingColName(e.target.value)}
                      onBlur={() => commitRenameColumn(col.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitRenameColumn(col.id); if (e.key === "Escape") setEditingColId(null); }}
                    />
                  ) : (
                    <button
                      className="flex-1 text-left text-sm font-semibold text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors"
                      onClick={() => { setEditingColId(col.id); setEditingColName(col.name); }}
                    >
                      {col.name}
                    </button>
                  )}
                  <span className="text-xs bg-[var(--color-background)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded-full font-medium min-w-[20px] text-center">
                    {colTasks.length}
                  </span>
                  <button
                    className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors"
                    onClick={() => handleDeleteColumn(col)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Cards (scrollable) */}
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colTasks.length === 0 && !isDropTarget && (
                    <div className="flex items-center justify-center py-8 rounded-lg border-2 border-dashed border-[var(--color-border)]">
                      <p className="text-xs text-[var(--color-text-muted)]">Sem tarefas</p>
                    </div>
                  )}
                  {colTasks.map((task) => (
                    <TaskCard
                      key={task.id} task={task} column={col}
                      deleting={deleting === task.id}
                      dragging={drag?.taskId === task.id && !!drag.active}
                      onDelete={() => handleDelete(task.id)}
                      onPointerDown={(e) => handleCardPointerDown(e, task.id, col.id)}
                      onClick={() => handleCardClick(task)}
                    />
                  ))}
                </div>

                {/* Add card inline (bottom, Trello style) */}
                <div className="p-2 flex-shrink-0 border-t border-[var(--color-border)]">
                  {addingTaskCol === col.id ? (
                    <div className="space-y-1.5">
                      <textarea
                        autoFocus
                        rows={2}
                        className="w-full px-3 py-2 border border-[var(--color-primary)] rounded-lg text-sm outline-none resize-none"
                        placeholder="Título da tarefa..."
                        value={inlineTitle}
                        onChange={(e) => setInlineTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInlineTask(col.id); }
                          if (e.key === "Escape") { setAddingTaskCol(null); setInlineTitle(""); }
                        }}
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => submitInlineTask(col.id)}
                          disabled={creating}
                          className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-medium disabled:opacity-50"
                        >
                          {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          Adicionar
                        </button>
                        <button
                          onClick={() => { setAddingTaskCol(null); setInlineTitle(""); }}
                          className="px-2 py-1.5 rounded-lg hover:bg-[var(--color-background)] text-[var(--color-text-muted)]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setAddingTaskCol(col.id); setInlineTitle(""); }}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-text-sub)] transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />Adicionar tarefa
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* New column inline card */}
          {addingColumn && (
            <div className="flex flex-col w-[272px] flex-shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-3 self-start">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Nova coluna</p>
              <input
                autoFocus
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                placeholder="Nome da coluna..."
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitAddColumn(); if (e.key === "Escape") setAddingColumn(false); }}
              />
              <div>
                <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Cor</p>
                <div className="flex flex-wrap gap-2">
                  {PALETTE.map((c) => (
                    <button key={c} type="button" onClick={() => setNewColColor(c)}
                      className={`w-6 h-6 rounded-full ${COLOR_DOT[c]} ring-offset-1 transition-all ${newColColor === c ? "ring-2 ring-[var(--color-primary)]" : ""}`}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={commitAddColumn} className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium">Criar</button>
                <button onClick={() => setAddingColumn(false)} className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)]">Cancelar</button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Drag ghost ── */}
      {drag?.active && draggedTask && draggedColumn && typeof window !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-[240px] rotate-2 rounded-xl border border-[var(--color-primary)] bg-white p-3.5 shadow-2xl opacity-90"
          style={{ left: drag.x - 32, top: drag.y - 20 }}
        >
          <p className="text-sm font-semibold text-[var(--color-text-main)] leading-snug">{draggedTask.title}</p>
          {draggedTask.body && <p className="mt-1 text-xs text-[var(--color-text-sub)] line-clamp-2">{draggedTask.body}</p>}
        </div>,
        document.body,
      )}

      {/* ── Nova tarefa modal ── */}
      {showCreateModal && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Nova tarefa</h2>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded-lg hover:bg-[var(--color-background)]">
                <X className="w-4 h-4 text-[var(--color-text-muted)]" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Coluna *</label>
              <select value={createColId} onChange={(e) => setCreateColId(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Título *</label>
              <input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="Descrever a tarefa..."
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Descrição</label>
              <textarea value={createBody} onChange={(e) => setCreateBody(e.target.value)}
                rows={3} placeholder="Detalhes adicionais..."
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)] resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Prioridade</label>
                <select value={createPriority} onChange={(e) => setCreatePriority(e.target.value as TaskPriority)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                  <option value="normal">Normal</option>
                  <option value="urgente">Urgente</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Data limite</label>
                <input type="date" value={createDue} onChange={(e) => setCreateDue(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]"
                />
              </div>
            </div>
            {members.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Atribuir a</label>
                <select value={createAssigned} onChange={(e) => setCreateAssigned(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                  <option value="">— Ninguém —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                </select>
              </div>
            )}
            {createError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{createError}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowCreateModal(false)}
                className="flex-1 px-4 py-2 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">
                Cancelar
              </button>
              <button onClick={submitCreateModal} disabled={creating}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Criar tarefa
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Detail popup ── */}
      {openTask && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={saveDetail} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Detalhes da tarefa</h2>
              <div className="flex gap-2">
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => handleDelete(openTask.id)}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-50">
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
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Descrição</label>
                <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)}
                  rows={3} placeholder="Detalhes adicionais..."
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)] resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Coluna</label>
                  <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                    {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Prioridade</label>
                  <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                    <option value="normal">Normal</option>
                    <option value="urgente">Urgente</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Data limite</label>
                  <input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)}
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]" />
                </div>
                {members.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1">Atribuir a</label>
                    <select value={editAssigned} onChange={(e) => setEditAssigned(e.target.value)}
                      className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-primary)]">
                      <option value="">— Ninguém —</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </div>
            <button onClick={saveDetail} disabled={savingDetail}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
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
