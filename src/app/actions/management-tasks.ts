"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export type TaskStatus = "pendente" | "em_curso" | "concluido";
export type TaskPriority = "normal" | "urgente";

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
}

export async function getManagementTasks(
  companyId: string,
): Promise<{ ok: true; tasks: ManagementTask[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("management_tasks")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) return { ok: false, error: error.message };

  const peopleIds = [
    ...new Set([
      ...(data ?? []).map((t) => t.assigned_to),
      ...(data ?? []).map((t) => t.created_by),
    ].filter(Boolean) as string[]),
  ];

  let names: Record<string, string> = {};
  if (peopleIds.length > 0) {
    const { data: profiles } = await admin.from("profiles").select("id, full_name").in("id", peopleIds);
    names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));
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
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado" };

  const admin = createAdminClient();
  const { error } = await admin.from("management_tasks").insert({
    company_id: companyId,
    title: input.title,
    body: input.body ?? null,
    status: input.status ?? "pendente",
    priority: input.priority ?? "normal",
    assigned_to: input.assigned_to ?? null,
    due_date: input.due_date ?? null,
    created_by: user.id,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

export async function updateManagementTask(
  taskId: string,
  data: Partial<TaskInput & { completed_at: string | null }>,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  const completedAt = data.status === "concluido"
    ? new Date().toISOString()
    : data.status !== undefined
    ? null
    : undefined;

  const { error } = await admin.from("management_tasks").update({
    updated_at: new Date().toISOString(),
    ...(data.title     !== undefined && { title:        data.title }),
    ...(data.body      !== undefined && { body:         data.body }),
    ...(data.status    !== undefined && { status:       data.status, completed_at: completedAt }),
    ...(data.priority  !== undefined && { priority:     data.priority }),
    ...(data.assigned_to !== undefined && { assigned_to: data.assigned_to }),
    ...(data.due_date  !== undefined && { due_date:     data.due_date }),
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
