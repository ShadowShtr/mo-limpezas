import { createAdminClient } from "@/lib/supabase/admin";

// TASK 22 — Auditoria central de ações críticas.
// Helper único para não depender de cada programador lembrar-se de auditar.
// Nunca lança: uma falha de auditoria não pode partir a operação principal.

type AdminClient = ReturnType<typeof createAdminClient>;

export type AuditSource = "mobile" | "dashboard" | "cron" | "sync";

export interface AuditLogParams {
  companyId: string;
  actorId: string | null;
  action: string;            // ex: "service_cancelled", "client_archived"
  entityType: string;        // ex: "service", "client", "invoice", "payroll"
  entityId?: string | null;
  before?: unknown;          // estado anterior (será resumido em meta.before)
  after?: unknown;           // estado novo (meta.after)
  meta?: Record<string, unknown>;
  source?: AuditSource;      // origem da ação
}

/** Remove campos sensíveis/volumosos antes de guardar no log. */
const SENSITIVE_KEYS = new Set([
  "password", "token", "signed_url", "signedUrl", "access_token",
  "service_role", "anon_key", "secret",
]);

export function sanitize(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…" : value;
  return value;
}

/**
 * Regista uma ação no audit_logs. Aceita um admin client já existente
 * (reutiliza ligação) ou cria um. Fire-and-forget seguro.
 */
export async function auditLog(
  params: AuditLogParams,
  adminClient?: AdminClient,
): Promise<void> {
  try {
    // audit_logs.actor_id é NOT NULL — ações sem ator humano (ex.: cron puro)
    // não podem ser auditadas nesta tabela. Não falhar silenciosamente noutro lado.
    if (!params.actorId) return;

    const admin = adminClient ?? createAdminClient();
    const meta: Record<string, unknown> = { ...(params.meta ?? {}) };
    if (params.before !== undefined) meta.before = sanitize(params.before);
    if (params.after !== undefined) meta.after = sanitize(params.after);
    if (params.source) meta.source = params.source;

    const { error } = await admin.from("audit_logs").insert({
      company_id: params.companyId,
      actor_id: params.actorId,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId ?? null,
      meta,
    });
    // Auditoria nunca bloqueia a operação principal, mas uma falha aqui não
    // pode desaparecer sem rasto — sem isto, a trilha de auditoria da app
    // inteira podia sumir silenciosamente (ex.: RLS/schema drift).
    if (error) {
      console.error(`[auditLog] falha ao gravar "${params.action}" (${params.entityType}):`, error.message);
    }
  } catch (e) {
    console.error(`[auditLog] erro inesperado ao gravar "${params.action}" (${params.entityType}):`, e);
  }
}
