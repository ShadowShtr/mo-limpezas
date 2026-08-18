// ============================================================================
// ANEXOS MÚLTIPLOS — contrato partilhado pelos três fluxos
// ============================================================================
// Helpers puros: caminho de storage, validação de tenant, limites e a forma do
// anexo que a UI recebe. Sem "use server", testável sem base de dados — mesmo
// padrão de src/lib/payment-attachments.ts e src/lib/service-photos.ts.
//
// Origem (2026-08-18): três fluxos guardavam UM anexo em colunas do próprio
// registo. Anexar um segundo sobrescrevia as colunas e, em Pagamentos, a
// action apagava o ficheiro anterior do storage antes de gravar o novo. Ver
// docs/ATTACHMENTS-MULTIPLE.md e supabase/migrations/074_attachments.sql.
//
// 🔴 As colunas legadas continuam a existir e a ser lidas. O que muda é que
//    deixam de ser o único sítio onde cabe um anexo.
// ============================================================================

/** Os três fluxos convertidos. O valor tem de coincidir com o CHECK da 074. */
export const PARENT_TYPES = ["fixed_variable_payment", "management_task", "absence"] as const;
export type AttachmentParentType = (typeof PARENT_TYPES)[number];

/**
 * `parent_type` chega do cliente. Nunca confiar nele sem passar por aqui: o
 * CHECK da tabela é a última linha de defesa, não a primeira.
 */
export function isAttachmentParentType(value: unknown): value is AttachmentParentType {
  return typeof value === "string" && (PARENT_TYPES as readonly string[]).includes(value);
}

/** Tabela pai de cada tipo — para revalidar ownership antes de ler ou remover. */
export const PARENT_TABLE = {
  fixed_variable_payment: "fixed_variable_payments",
  management_task: "management_tasks",
  absence: "absences",
} as const satisfies Record<AttachmentParentType, string>;

/**
 * Bucket por tipo. Reutiliza os buckets que já existem para pagamentos e
 * tarefas — os ficheiros legados vivem lá, e não faz sentido separá-los dos
 * novos. As faltas ganham bucket próprio (o fluxo nunca teve um).
 */
export const PARENT_BUCKET: Record<AttachmentParentType, string> = {
  fixed_variable_payment: "payment-attachments",
  management_task: "task-attachments",
  absence: "absence-documents",
};

// ── Limites ─────────────────────────────────────────────────────────────────
// 20 MB é o que payment-attachments e task-attachments já praticavam; mantido
// para não apertar um limite que os utilizadores conhecem.

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Quantos anexos NOVOS por registo. O legado não conta para o limite. */
export const MAX_ATTACHMENTS_PER_PARENT = 20;

/**
 * Fatura, recibo, comprovativo, foto de avaria, baixa médica. Deliberadamente
 * uma lista fechada: um bucket privado que aceite qualquer tipo é uma
 * superfície de upload arbitrário.
 */
export const ALLOWED_ATTACHMENT_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
] as const;

export function isAllowedAttachmentMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return (ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(mime.toLowerCase());
}

export type AttachmentValidationError =
  | { ok: false; code: "EMPTY"; error: string }
  | { ok: false; code: "TOO_LARGE"; error: string }
  | { ok: false; code: "MIME_NOT_ALLOWED"; error: string }
  | { ok: false; code: "TOO_MANY"; error: string };

/** Validação de um ficheiro antes de tocar no storage. */
export function validateAttachmentFile(params: {
  size: number;
  mime: string | null;
  existingCount: number;
}): { ok: true } | AttachmentValidationError {
  if (params.size <= 0) {
    return { ok: false, code: "EMPTY", error: "O ficheiro está vazio." };
  }
  if (params.size > MAX_ATTACHMENT_BYTES) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
    return { ok: false, code: "TOO_LARGE", error: `O ficheiro excede ${mb} MB.` };
  }
  if (!isAllowedAttachmentMime(params.mime)) {
    return { ok: false, code: "MIME_NOT_ALLOWED", error: `Tipo de ficheiro não permitido: ${params.mime ?? "desconhecido"}.` };
  }
  if (params.existingCount >= MAX_ATTACHMENTS_PER_PARENT) {
    return { ok: false, code: "TOO_MANY", error: `Máximo de ${MAX_ATTACHMENTS_PER_PARENT} anexos por registo.` };
  }
  return { ok: true };
}

// ── Caminhos de storage ─────────────────────────────────────────────────────

/**
 * 🔴 Colapsa sequências de pontos, além de trocar os caracteres inseguros.
 *
 * Os helpers anteriores (`sanitizeAttachmentFileName` em payment-attachments)
 * trocavam `/` por `_` mas deixavam os pontos: `../../etc/passwd` saía como
 * `.._.._etc_passwd`. Isso é inofensivo enquanto caminho — não há separador,
 * logo não há travessia — mas `isAttachmentPathInCompany` recusa qualquer
 * caminho que contenha `..`, e o anexo ficava impossível de abrir ou remover
 * depois de gravado. Um ficheiro preso.
 *
 * Apanha também o caso benigno: `relatório..final.pdf`.
 */
export function sanitizeAttachmentFileName(fileName: string): string {
  const safeName = fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".");
  return safeName || "anexo";
}

/**
 * `company/parent/timestamp-nome` — o prefixo de empresa é o que torna
 * `isAttachmentPathInCompany` capaz de recusar leituras cross-tenant.
 */
export function buildAttachmentPath(params: {
  companyId: string;
  parentId: string;
  fileName: string;
  now?: number;
}): string {
  const stamp = params.now ?? Date.now();
  return `${params.companyId}/${params.parentId}/${stamp}-${sanitizeAttachmentFileName(params.fileName)}`;
}

/** Impede travessia de directórios e acesso cross-tenant ao assinar URLs. */
export function isAttachmentPathInCompany(storagePath: string, companyId: string): boolean {
  if (!storagePath || !companyId) return false;
  if (storagePath.includes("..")) return false;
  return storagePath.startsWith(`${companyId}/`);
}

// ── A forma que a UI recebe ─────────────────────────────────────────────────

/**
 * Um anexo, venha ele da tabela `attachments` ou das colunas legadas.
 *
 * `source` existe porque remover um legado e remover um novo são operações
 * diferentes — a primeira limpa colunas do registo pai, a segunda apaga uma
 * linha. Esconder essa diferença atrás de lógica implícita era exactamente o
 * que se queria evitar.
 */
export interface AttachmentView {
  id: string;
  source: "legacy" | "attachments";
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  /** Só para `source: "legacy"` — a URL que já estava guardada na coluna. */
  legacyUrl?: string | null;
  /** Só para `source: "attachments"` — para assinar a leitura. */
  storageBucket?: string;
  storagePath?: string;
}

/**
 * Identidade sintética e determinística do anexo legado.
 *
 * Determinística de propósito: a UI precisa de uma `key` estável entre
 * renders, e a remoção precisa de saber que aquilo é o legado daquele
 * registo — não uma linha de `attachments`.
 */
export function legacyAttachmentId(parentType: AttachmentParentType, parentId: string): string {
  return `legacy:${parentType}:${parentId}`;
}

export function isLegacyAttachmentId(id: string): boolean {
  return id.startsWith("legacy:");
}

/**
 * Junta o anexo legado (se existir) com os novos, numa lista só.
 *
 * O legado vem primeiro: é o mais antigo, e é o que o utilizador já conhecia
 * naquele registo. Os novos seguem por ordem de criação.
 *
 * 🔴 Não copia o legado para `attachments` — se copiasse, apareceria duas
 *    vezes na UI. A combinação é feita na leitura, sempre.
 */
export function combineAttachments(params: {
  parentType: AttachmentParentType;
  parentId: string;
  legacy: { url: string | null; name: string | null; size?: number | null; mime?: string | null } | null;
  rows: {
    id: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number | string | null;
    created_at: string;
    storage_bucket: string;
    storage_path: string;
  }[];
}): AttachmentView[] {
  const out: AttachmentView[] = [];

  if (params.legacy?.url) {
    out.push({
      id: legacyAttachmentId(params.parentType, params.parentId),
      source: "legacy",
      name: params.legacy.name || "anexo",
      mimeType: params.legacy.mime ?? null,
      sizeBytes: params.legacy.size ?? null,
      createdAt: null,
      legacyUrl: params.legacy.url,
    });
  }

  for (const r of params.rows) {
    out.push({
      id: r.id,
      source: "attachments",
      name: r.original_name,
      mimeType: r.mime_type,
      // bigint chega como string no driver do Postgres.
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      createdAt: r.created_at,
      storageBucket: r.storage_bucket,
      storagePath: r.storage_path,
    });
  }

  return out;
}
