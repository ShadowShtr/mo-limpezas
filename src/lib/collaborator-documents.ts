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
