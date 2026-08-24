// ─── Categoria de documento ──────────────────────────────────────────────────
//
// 🔴 Isto vive aqui, e não em `src/app/actions/collaborator-documents.ts`, por
//    uma razão do Next.js e não de arrumação: um ficheiro com `"use server"`
//    **só pode exportar funções async**. Exportar de lá uma constante ou uma
//    função síncrona rebenta a compilação com «a "use server" file can only
//    export async functions» — o mesmo erro que já derrubou as notificações do
//    calendário em 2026-06-08, quando `CANCEL_TYPE_LABELS` foi exportado de um
//    ficheiro de actions.
//
//    O tipo podia lá ficar (tipos são apagados na compilação), mas mantê-lo
//    junto do parser e da lista evita que a próxima pessoa os separe outra vez.

export const DOCUMENT_CATEGORIES = [
  "contrato",
  "recibo_salario",
  "identificacao",
  "avaria",
  "outro",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * Substitui `category as DocumentCategory`.
 *
 * Um `as` não valida nada — é uma afirmação ao compilador, não uma verificação
 * em execução. O valor chega de um `FormData` do browser, portanto podia ser
 * qualquer string e ia inteira para a coluna. Devolve `null` para desconhecido;
 * quem chama recusa **antes** de escrever no armazenamento.
 */
export function parseDocumentCategory(value: unknown): DocumentCategory | null {
  return typeof value === "string"
    && (DOCUMENT_CATEGORIES as readonly string[]).includes(value)
    ? (value as DocumentCategory)
    : null;
}

export type DamageReportManager = { id: string };

export type DamageReportNotificationInput = {
  companyId: string;
  collaboratorId: string;
  collaboratorName: string | null | undefined;
  documentId: string;
  notes: string | null | undefined;
  managers: DamageReportManager[] | null | undefined;
};

export function sanitizeDocumentFileName(fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeName || "documento";
}

export function buildDocumentStoragePath(params: {
  companyId: string;
  collaboratorId: string;
  fileName: string;
  now?: number;
}): string {
  return `${params.companyId}/${params.collaboratorId}/${params.now ?? Date.now()}-${sanitizeDocumentFileName(params.fileName)}`;
}

export function isCollaboratorProfileRole(role: string | null | undefined): boolean {
  return role === "colaborador";
}

/**
 * Verifica se um caminho de storage (`${companyId}/${collaboratorId}/...`)
 * pertence à empresa indicada. Usado para impedir que um signed URL seja gerado
 * para ficheiros de outra empresa (um signed URL ignora as políticas de storage).
 */
export function isStoragePathInCompany(
  storagePath: string,
  companyId: string,
): boolean {
  if (!storagePath || !companyId) return false;
  // Bloquear travessia de diretórios e prefixos parciais (ex: "company1" vs "company12").
  if (storagePath.includes("..")) return false;
  return storagePath.startsWith(`${companyId}/`);
}

export function buildDamageReportNotificationRows(input: DamageReportNotificationInput) {
  const name = input.collaboratorName || "Uma colaboradora";
  return (input.managers ?? []).map((manager) => ({
    company_id: input.companyId,
    user_id: manager.id,
    type: "damage_report_submitted",
    title: `${name} enviou um relatório de avaria`,
    body: input.notes ? `"${input.notes}"` : "Consulte os documentos para ver a imagem.",
    data: { document_id: input.documentId, collaborator_id: input.collaboratorId },
  }));
}
