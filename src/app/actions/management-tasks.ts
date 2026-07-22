"use server";

import { requireProfile } from "@/lib/auth-guard";
import { notifyUser } from "@/lib/push-notify";
import { revalidatePath } from "next/cache";
import type { TaskCategory } from "@/lib/task-categories";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  TASK_ATTACHMENTS_BUCKET,
  MAX_TASK_ATTACHMENT_BYTES,
  buildTaskAttachmentPath,
  isTaskAttachmentPathInCompany,
} from "@/lib/task-attachments";

type AdminClient = ReturnType<typeof createAdminClient>;

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
  category: TaskCategory | null;
  client_id: string | null;
  client_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  due_date: string | null;
  completed_at: string | null;
  attachment_url: string | null;
  attachment_name: string | null;
  created_at: string;
}

export interface TaskInput {
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  category?: TaskCategory | null;
  client_id?: string | null;
  assigned_to?: string | null;
  due_date?: string | null;
  /** Pass true when moving to a "completed" column so completed_at is set */
  markCompleted?: boolean;
}

export async function getManagementTasks(
  _companyId?: string,
): Promise<{ ok: true; tasks: ManagementTask[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

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

  const clientIds = [...new Set((data ?? []).map((t) => t.client_id).filter(Boolean) as string[])];
  const clientNames: Record<string, string> = {};
  if (clientIds.length > 0) {
    const { data: clients } = await admin.from("clients").select("id, name").in("id", clientIds);
    for (const c of clients ?? []) clientNames[c.id] = c.name;
  }

  const tasks: ManagementTask[] = (data ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    category: (t.category as TaskCategory | null) ?? null,
    client_id: t.client_id,
    client_name: t.client_id ? (clientNames[t.client_id] ?? null) : null,
    assigned_to: t.assigned_to,
    assigned_to_name: t.assigned_to ? (names[t.assigned_to] ?? null) : null,
    created_by: t.created_by,
    created_by_name: t.created_by ? (names[t.created_by] ?? null) : null,
    due_date: t.due_date,
    completed_at: t.completed_at,
    attachment_url: t.attachment_url,
    attachment_name: t.attachment_name,
    created_at: t.created_at,
  }));

  return { ok: true, tasks };
}

export async function createManagementTask(
  _companyId: string,
  input: TaskInput,
): Promise<{ ok: true; task: ManagementTask } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const user = { id: guard.profile.id };

  const { data: row, error } = await admin
    .from("management_tasks")
    .insert({
      company_id: guard.profile.company_id,
      title: input.title,
      body: input.body ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: (input.status ?? "pendente") as any,
      priority: input.priority ?? "normal",
      category: input.category ?? null,
      client_id: input.client_id ?? null,
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

  let clientName: string | null = null;
  if (row.client_id) {
    const { data: client } = await admin.from("clients").select("name").eq("id", row.client_id).single();
    clientName = client?.name ?? null;
  }

  if (row.assigned_to && row.assigned_to !== user.id) {
    await notifyUser(admin, {
      companyId: guard.profile.company_id,
      userId: row.assigned_to,
      type: "task_assigned",
      title: "📋 Nova tarefa atribuída",
      body: `${createdByName ?? "Alguém"} atribuiu-te a tarefa "${row.title}".`,
      data: { task_id: row.id },
      url: "/dashboard/tarefas",
    });
  }

  const task: ManagementTask = {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    category: (row.category as TaskCategory | null) ?? null,
    client_id: row.client_id,
    client_name: clientName,
    assigned_to: row.assigned_to,
    assigned_to_name: assignedName,
    created_by: row.created_by,
    created_by_name: createdByName,
    due_date: row.due_date,
    completed_at: row.completed_at,
    attachment_url: row.attachment_url,
    attachment_name: row.attachment_name,
    created_at: row.created_at,
  };

  revalidatePath("/dashboard/tarefas");
  return { ok: true, task };
}

export async function updateManagementTask(
  taskId: string,
  data: Partial<TaskInput & { completed_at: string | null }>,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  // completedAt: set when caller explicitly marks as complete, clear when status changes, leave untouched onwards
  const completedAt = data.markCompleted
    ? new Date().toISOString()
    : data.status !== undefined
    ? null
    : undefined;

  // Estado anterior — só para saber se a tarefa mudou de responsável (avisar
  // a pessoa nova) e para a mensagem da notificação (título da tarefa).
  let previousAssignedTo: string | null = null;
  let previousTitle: string | null = null;
  if (data.assigned_to !== undefined) {
    const { data: before } = await admin
      .from("management_tasks")
      .select("assigned_to, title")
      .eq("id", taskId)
      .eq("company_id", profile.company_id)
      .single();
    previousAssignedTo = before?.assigned_to ?? null;
    previousTitle = before?.title ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from("management_tasks") as any).update({
    updated_at: new Date().toISOString(),
    ...(data.title       !== undefined && { title:        data.title }),
    ...(data.body        !== undefined && { body:         data.body }),
    ...(data.status      !== undefined && { status:       data.status, completed_at: completedAt }),
    ...(data.priority    !== undefined && { priority:     data.priority }),
    ...(data.category    !== undefined && { category:     data.category }),
    ...(data.client_id   !== undefined && { client_id:    data.client_id }),
    ...(data.assigned_to !== undefined && { assigned_to:  data.assigned_to }),
    ...(data.due_date    !== undefined && { due_date:     data.due_date }),
  }).eq("id", taskId).eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };

  if (
    data.assigned_to !== undefined &&
    data.assigned_to &&
    data.assigned_to !== previousAssignedTo &&
    data.assigned_to !== profile.id
  ) {
    const { data: assigner } = await admin.from("profiles").select("full_name").eq("id", profile.id).single();
    await notifyUser(admin, {
      companyId: profile.company_id,
      userId: data.assigned_to,
      type: "task_assigned",
      title: "📋 Nova tarefa atribuída",
      body: `${assigner?.full_name ?? "Alguém"} atribuiu-te a tarefa "${data.title ?? previousTitle ?? "sem título"}".`,
      data: { task_id: taskId },
      url: "/dashboard/tarefas",
    });
  }

  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

export async function deleteManagementTask(
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const { error } = await admin
    .from("management_tasks")
    .delete()
    .eq("id", taskId)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

// ─── Anexo da tarefa ──────────────────────────────────────────────────────────

async function ensureTaskAttachmentsBucket(admin: AdminClient) {
  const { error } = await admin.storage.getBucket(TASK_ATTACHMENTS_BUCKET);
  if (error) {
    await admin.storage.createBucket(TASK_ATTACHMENTS_BUCKET, {
      public: false,
      fileSizeLimit: MAX_TASK_ATTACHMENT_BYTES,
    });
  }
}

export async function uploadTaskAttachment(
  taskId: string,
  formData: FormData,
): Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: task } = await admin
    .from("management_tasks")
    .select("id, attachment_url")
    .eq("id", taskId)
    .eq("company_id", profile.company_id)
    .single();
  if (!task) return { ok: false, error: "Tarefa não encontrada." };

  const file = formData.get("file") as File | null;
  if (!file) return { ok: false, error: "Ficheiro em falta." };
  if (file.size > MAX_TASK_ATTACHMENT_BYTES) {
    return { ok: false, error: "Ficheiro demasiado grande (máx 20 MB)." };
  }

  await ensureTaskAttachmentsBucket(admin);

  const path = buildTaskAttachmentPath({ companyId: profile.company_id, taskId, fileName: file.name });
  const { error: uploadError } = await admin.storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  // Substitui um anexo anterior — remove o ficheiro antigo do storage.
  if (task.attachment_url) {
    const bucketPrefix = `/${TASK_ATTACHMENTS_BUCKET}/`;
    const oldPath = task.attachment_url.includes(bucketPrefix)
      ? decodeURIComponent(task.attachment_url.split(bucketPrefix)[1])
      : null;
    if (oldPath && isTaskAttachmentPathInCompany(oldPath, profile.company_id)) {
      await admin.storage.from(TASK_ATTACHMENTS_BUCKET).remove([oldPath]);
    }
  }

  const { data: urlData } = admin.storage.from(TASK_ATTACHMENTS_BUCKET).getPublicUrl(path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbError } = await (admin.from("management_tasks") as any).update({
    attachment_url: urlData.publicUrl,
    attachment_name: file.name,
    attachment_size: file.size,
    attachment_mime: file.type,
    updated_at: new Date().toISOString(),
  }).eq("id", taskId).eq("company_id", profile.company_id);
  if (dbError) return { ok: false, error: dbError.message };

  revalidatePath("/dashboard/tarefas");
  return { ok: true, url: urlData.publicUrl, name: file.name };
}

export async function deleteTaskAttachment(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: task } = await admin
    .from("management_tasks")
    .select("attachment_url")
    .eq("id", taskId)
    .eq("company_id", profile.company_id)
    .single();
  if (!task) return { ok: false, error: "Tarefa não encontrada." };

  if (task.attachment_url) {
    const bucketPrefix = `/${TASK_ATTACHMENTS_BUCKET}/`;
    const path = task.attachment_url.includes(bucketPrefix)
      ? decodeURIComponent(task.attachment_url.split(bucketPrefix)[1])
      : null;
    if (path && isTaskAttachmentPathInCompany(path, profile.company_id)) {
      await admin.storage.from(TASK_ATTACHMENTS_BUCKET).remove([path]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from("management_tasks") as any).update({
    attachment_url: null, attachment_name: null, attachment_size: null, attachment_mime: null,
    updated_at: new Date().toISOString(),
  }).eq("id", taskId).eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}

export async function getSignedTaskAttachmentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!fileUrl) return { ok: false, error: "URL do ficheiro em falta." };
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const bucketPrefix = `/${TASK_ATTACHMENTS_BUCKET}/`;
  const storagePath = fileUrl.includes(bucketPrefix) ? fileUrl.split(bucketPrefix)[1] : null;
  if (!storagePath) return { ok: true, url: fileUrl };

  const decodedPath = decodeURIComponent(storagePath);
  if (!isTaskAttachmentPathInCompany(decodedPath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
  }

  const { data, error } = await admin.storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .createSignedUrl(decodedPath, 60 * 5);
  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link." };

  return { ok: true, url: data.signedUrl };
}

export async function getKanbanColumns(_companyId?: string): Promise<KanbanColumn[]> {
  const guard = await requireProfile();
  if (!guard.ok) return DEFAULT_KANBAN_COLUMNS;
  const { admin, profile } = guard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin.from("company_settings") as any)
    .select("kanban_columns")
    .eq("company_id", profile.company_id)
    .single();
  if (!data?.kanban_columns) return DEFAULT_KANBAN_COLUMNS;
  return data.kanban_columns as KanbanColumn[];
}

export async function saveKanbanColumns(
  _companyId: string,
  columns: KanbanColumn[],
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.from("company_settings") as any)
    .update({ kanban_columns: columns })
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: (error as { message: string }).message };
  revalidatePath("/dashboard/tarefas");
  return { ok: true };
}
