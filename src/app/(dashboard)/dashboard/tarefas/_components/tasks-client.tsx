"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  Plus, X, Loader2, AlertTriangle, CheckSquare, Circle, ArrowRight,
  Trash2, User, Calendar, ChevronRight,
} from "lucide-react";
import {
  createManagementTask,
  updateManagementTask,
  deleteManagementTask,
  type ManagementTask,
  type TaskStatus,
  type TaskPriority,
  type TaskInput,
} from "@/app/actions/management-tasks";

interface Assignee {
  id: string;
  full_name: string;
}

interface Props {
  initialTasks: ManagementTask[];
  companyId: string;
  members: Assignee[];
}

const COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: "pendente",   label: "Pendente",  color: "border-amber-400" },
  { status: "em_curso",  label: "Em Curso",  color: "border-blue-400" },
  { status: "concluido", label: "Concluído", color: "border-green-400" },
];

function StatusBadge({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, string> = {
    pendente: "bg-amber-100 text-amber-700",
    em_curso: "bg-blue-100 text-blue-700",
    concluido: "bg-green-100 text-green-700",
  };
  const labels: Record<TaskStatus, string> = {
    pendente: "Pendente",
    em_curso: "Em Curso",
    concluido: "Concluído",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === "urgente") {
    return (
      <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
        <AlertTriangle className="w-3 h-3" />
        Urgente
      </span>
    );
  }
  return null;
}

function fmtDate(s: string | null) {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (d.getTime() - today.getTime()) / 86400000;
  if (diff < 0) return { label: new Date(s).toLocaleDateString("pt-PT"), overdue: true };
  return { label: new Date(s).toLocaleDateString("pt-PT"), overdue: false };
}

interface TaskCardProps {
  task: ManagementTask;
  onMove: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  members: Assignee[];
  moving: string | null;
  deleting: string | null;
}

function TaskCard({ task, onMove, onDelete, members, moving, deleting }: TaskCardProps) {
  const due = fmtDate(task.due_date);
  const nextStatuses: TaskStatus[] = task.status === "pendente"
    ? ["em_curso"]
    : task.status === "em_curso"
    ? ["concluido", "pendente"]
    : ["em_curso"];

  return (
    <div className={`bg-white rounded-xl border border-[var(--color-border)] p-4 space-y-3 shadow-sm ${task.priority === "urgente" ? "border-l-4 border-l-red-400" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--color-text-main)] leading-snug flex-1">{task.title}</p>
        <button
          onClick={() => onDelete(task.id)}
          disabled={deleting === task.id}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
        >
          {deleting === task.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {task.body && (
        <p className="text-xs text-[var(--color-text-sub)] leading-relaxed line-clamp-2">{task.body}</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <PriorityBadge priority={task.priority} />
        {due && (
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${due.overdue ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"}`}>
            <Calendar className="w-3 h-3" />
            {due.label}
          </span>
        )}
        {task.assigned_to_name && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium">
            <User className="w-3 h-3" />
            {task.assigned_to_name}
          </span>
        )}
      </div>

      {/* Move buttons */}
      <div className="flex gap-1 pt-1 border-t border-[var(--color-border)]">
        {nextStatuses.map((s) => (
          <button
            key={s}
            onClick={() => onMove(task.id, s)}
            disabled={moving === task.id}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors disabled:opacity-40"
          >
            {moving === task.id ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {s === "em_curso" ? "Em Curso" : s === "concluido" ? "Concluir" : "Pendente"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TasksClient({ initialTasks, companyId, members }: Props) {
  const [tasks, setTasks] = useState(initialTasks);
  const [showModal, setShowModal] = useState(false);
  const [creating, startCreate] = useTransition();
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");

  function resetForm() {
    setTitle(""); setBody(""); setPriority("normal"); setAssignedTo(""); setDueDate("");
    setCreateError(null);
  }

  function handleCreate() {
    if (!title.trim()) { setCreateError("O título é obrigatório"); return; }
    setCreateError(null);
    const input: TaskInput = {
      title: title.trim(),
      body: body.trim() || null,
      priority,
      assigned_to: assignedTo || null,
      due_date: dueDate || null,
    };
    startCreate(async () => {
      const res = await createManagementTask(companyId, input);
      if (!res.ok) { setCreateError(res.error ?? "Erro ao criar tarefa"); return; }
      // Optimistic add
      const fake: ManagementTask = {
        id: `temp-${Date.now()}`,
        title: input.title,
        body: input.body ?? null,
        status: "pendente",
        priority: input.priority ?? "normal",
        assigned_to: input.assigned_to ?? null,
        assigned_to_name: members.find((m) => m.id === input.assigned_to)?.full_name ?? null,
        created_by: null,
        created_by_name: null,
        due_date: input.due_date ?? null,
        completed_at: null,
        created_at: new Date().toISOString(),
      };
      setTasks((prev) => [fake, ...prev]);
      setShowModal(false);
      resetForm();
    });
  }

  async function handleMove(id: string, status: TaskStatus) {
    setMoving(id);
    const res = await updateManagementTask(id, { status });
    if (res.ok) {
      setTasks((prev) => prev.map((t) => t.id === id ? {
        ...t, status,
        completed_at: status === "concluido" ? new Date().toISOString() : null,
      } : t));
    }
    setMoving(null);
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    const res = await deleteManagementTask(id);
    if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== id));
    setDeleting(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button
          onClick={() => { resetForm(); setShowModal(true); }}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          Nova tarefa
        </button>
      </div>

      {/* Kanban grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {COLUMNS.map(({ status, label, color }) => {
          const col = tasks.filter((t) => t.status === status);
          return (
            <div key={status} className="flex flex-col bg-[var(--color-background)] rounded-xl border border-[var(--color-border)] overflow-hidden min-h-[300px]">
              <div className={`flex items-center gap-2 px-4 py-3 bg-white border-b border-[var(--color-border)] border-l-4 ${color}`}>
                <span className="text-sm font-semibold text-[var(--color-text-main)]">{label}</span>
                <span className="ml-auto text-xs bg-[var(--color-background)] text-[var(--color-text-muted)] px-2 py-0.5 rounded-full font-medium min-w-[20px] text-center">
                  {col.length}
                </span>
              </div>
              <div className="flex-1 p-3 space-y-2">
                {col.length === 0 ? (
                  <div className="flex items-center justify-center py-10 rounded-lg border-2 border-dashed border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-muted)]">Sem tarefas</p>
                  </div>
                ) : (
                  col.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onMove={handleMove}
                      onDelete={handleDelete}
                      members={members}
                      moving={moving}
                      deleting={deleting}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create modal */}
      {showModal && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Nova tarefa</h2>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-[var(--color-background)]">
                <X className="w-4 h-4 text-[var(--color-text-muted)]" />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Título *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Descrever a tarefa..."
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Descrição</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Detalhes adicionais..."
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Prioridade</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                >
                  <option value="normal">Normal</option>
                  <option value="urgente">Urgente</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data limite</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                />
              </div>
            </div>

            {members.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Atribuir a</label>
                <select
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                >
                  <option value="">— Ninguém —</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              </div>
            )}

            {createError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{createError}</p>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 rounded-xl border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Criar tarefa
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
