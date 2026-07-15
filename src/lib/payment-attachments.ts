// Helpers puros do anexo de pagamentos (path + validação) — mesmo padrão de
// src/lib/collaborator-documents.ts. Sem "use server", testável sem BD.

export const PAYMENT_ATTACHMENTS_BUCKET = "payment-attachments";
export const MAX_PAYMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

export function sanitizeAttachmentFileName(fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeName || "anexo";
}

export function buildPaymentAttachmentPath(params: {
  companyId: string;
  paymentId: string;
  fileName: string;
  now?: number;
}): string {
  return `${params.companyId}/${params.paymentId}/${params.now ?? Date.now()}-${sanitizeAttachmentFileName(params.fileName)}`;
}

/** Impede travessia de diretórios e cross-tenant ao assinar URLs de leitura. */
export function isPaymentAttachmentPathInCompany(
  storagePath: string,
  companyId: string,
): boolean {
  if (!storagePath || !companyId) return false;
  if (storagePath.includes("..")) return false;
  return storagePath.startsWith(`${companyId}/`);
}
