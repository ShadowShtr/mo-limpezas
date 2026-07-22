// Helpers puros do anexo de tarefas (path + validação) — mesmo padrão de
// src/lib/payment-attachments.ts. Sem "use server", testável sem BD.

export const TASK_ATTACHMENTS_BUCKET = "task-attachments";
export const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

export function sanitizeTaskAttachmentFileName(fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeName || "anexo";
}

export function buildTaskAttachmentPath(params: {
  companyId: string;
  taskId: string;
  fileName: string;
  now?: number;
}): string {
  return `${params.companyId}/${params.taskId}/${params.now ?? Date.now()}-${sanitizeTaskAttachmentFileName(params.fileName)}`;
}

/** Impede travessia de diretórios e cross-tenant ao assinar URLs de leitura. */
export function isTaskAttachmentPathInCompany(
  storagePath: string,
  companyId: string,
): boolean {
  if (!storagePath || !companyId) return false;
  if (storagePath.includes("..")) return false;
  return storagePath.startsWith(`${companyId}/`);
}
