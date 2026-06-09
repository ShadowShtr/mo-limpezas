"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export type TaskStatus = string; // free-form to support custom columns
export type TaskPriority = "normal" | "urgente";

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
}

const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: "pendente",  name: "Pendente",  color: "amber" },
  { id: "em_curso",  name: "Em Curso",  color: "blue" },
  { id: "concluido", name: "Concluído", color: "green" },
];

export interface ManagementTask {
  id: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TaskInput {
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigned_to?: string | null;
  due_date?: string | null;
  /** Pass true when moving to a "completed" column so completed_at is set */
  markCompleted?: boolean;
}

export async function getManagementTasks(
  companyId: string,
): Promise<{ ok: true; tasks: ManagementTask[] } | { ok: false; error: string }> {
  const admin = createAdminClient();

  // Collect unique people IDs from a first query then fetch profiles in parallel
  const { data, error } = await admin
    .from("management_tasks")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) return { ok: false, error: error.message };

  const peopleIds = [
    ...new Set(
      [...(data ?? []).map((t) => t.assigned_to), ...(data ?? []).map((t) => t.created_by)]
        .filter(Boolean) as string[],
    ),
  ];

  const names: Record<string, string> = {};
  if (peopleIds.length > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", peopleIds);
    for (const p of profiles ?? []) names[p.id] = p.full_name;
  }

  const tasks: ManagementTask[] = (data ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    assigned_to: t.assigned_to,
    assigned_to_name: t.assigned_to ? (names[t.assigned_to] ?? null) : null,
    created_by: t.created_by,
    created_by_name: t.created_by ? (names[t.created_by] ?? null) : null,
    due_date: t.due_date,
    completed_at: t.completed_at,
    created_at: t.created_at,
  }));

  return { ok: true, tasks };
}

export async function createManagementTask(
  companyId: string,
  input: TaskInput,
): Promise<{ ok: true; task: ManagementTask } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("management_tasks")
    .insert({
      company_id: companyId,
      title: input.title,
      body: input.body ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: (input.status ?? "pendente") as any,
      priority: input.priority ?? "normal",
      assigned_to: input.assigned_to ?? null,
      due_date: input.due_date ?? null,
      created_by: user.id,
    })
    .select("*")
    .single();

  if (error || !row) return { ok: false, error: error?.message ?? "Erro ao criar" };

  let assignedName: string | null = null;
  let createdByName: string | null = null;
  const idsToFetch = [row.assigned_to, row.created_by].filter(Boolean) as string[];
  if (idsToFetch.length > 0) {
    const { data: profiles } = await admin.from("profiles").select("id, full_name").in("id", idsToFetch);
    const map = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));
    assignedName = row.assigned_to ? (map[row.assigned_to] ?? null) : null;
    createdByName = row.created_by ? (map[row.created_by] ?? null) : null;
  }

  const task: ManagementTask = {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigned_to: row.assigned_to,
    assigned_to_name: assignedName,
    created_by: row.created_by,
    created_by_name: createdByName,
    due_date: row.due_date,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };

  revalidatePath("/dashboard/tarefas");
  return { ok: true, task };
}

export async function updateManagementTask(
  taskId: string,
  data: Partial<TaskInput & { completed_at: string | null }>,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  // completedAt: set when caller explicitly marks as complete, clear when status changes, leave untouched otherwise
  const completedAt = data.markCompleted
    ? new Date().toISOString()
    : data.status !== undefined
    ? null
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from("management_tasks") as any).update({
    updated_at: new Date().toISOString(),
    ...(data.title       !== undefined && { title:        data.title }),
    ...(data.body        !== undefined && { body:         data.body }),
    ...(data.status      !== undefined && { status:       data.status, completed_at: completedAt }),
    ...(data.priority    !== undefined && { priority:     data.priority }),
    ...(data.assigned_to !== undefined && { assigned_to:  data.assigned_to }),
    ...(data.due_date    !== undefined && { due_date:     data.due_date }),
  }).eq("id", taskId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

export async function deleteManagementTask(
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from("management_tasks").delete().eq("id", taskId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

export async function getKanbanColumns(companyId: string): Promise<KanbanColumn[]> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin.from("company_settings") as any)
    .select("kanban_columns")
    .eq("company_id", companyId)
    .single();
  if (!data?.kanban_columns) return DEFAULT_KANBAN_COLUMNS;
  return data.kanban_columns as KanbanColumn[];
}

export async function saveKanbanColumns(
  companyId: string,
  columns: KanbanColumn[],
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from("company_settings") as any)
    .update({ kanban_columns: columns })
    .eq("company_id", companyId);
  if (error) return { ok: false, error: (error as { message: string }).message };
  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}
