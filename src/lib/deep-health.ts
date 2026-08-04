import { createAdminClient } from "@/lib/supabase/admin";
import { CURRENT_MIGRATION_FILE, CURRENT_MIGRATION_VERSION, deployBranch, deployCommit, deployEnv, supabaseProjectRef } from "@/lib/deploy-info";

export interface HealthCheck {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface DeepHealthReport {
  ok: boolean;
  checks: Record<string, HealthCheck>;
  deploy: {
    commit: string;
    branch: string | null;
    env: string;
    migrationVersion: string;
    supabaseProjectRef: string | null;
  };
  ts: string;
}

/**
 * Única implementação dos checks profundos — usada por /api/health/deep e
 * pela página /dashboard/sistema/diagnostico. Nunca duplicar esta lógica
 * (ver AGENTS.md regra 10 / plano de correção T01).
 */
export async function getDeepHealthReport(): Promise<DeepHealthReport> {
  const admin = createAdminClient();
  const checks: Record<string, HealthCheck> = {};

  // ── DB ────────────────────────────────────────────────────────────────────────
  const dbStart = Date.now();
  try {
    const { error } = await admin.from("companies").select("id").limit(1);
    checks.db = { ok: !error, latencyMs: Date.now() - dbStart, error: error?.message };
  } catch (e) {
    checks.db = { ok: false, error: String(e) };
  }

  // ── Storage (bucket service-photos) ──────────────────────────────────────────
  const storageStart = Date.now();
  try {
    const { error } = await admin.storage.from("service-photos").list("", { limit: 1 });
    checks.storage = { ok: !error, latencyMs: Date.now() - storageStart, error: error?.message };
  } catch (e) {
    checks.storage = { ok: false, error: String(e) };
  }

  // ── Migration ledger real vs código publicado ────────────────────────────────
  const migStart = Date.now();
  try {
    const { data, error } = await admin
      .from("_migrations")
      .select("name")
      .order("name", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      checks.migration = { ok: false, latencyMs: Date.now() - migStart, error: error.message };
    } else {
      const appliedName = (data as { name?: string } | null)?.name ?? null;
      const appliedVersion = appliedName?.slice(0, 3) ?? null;
      const upToDate = appliedVersion === CURRENT_MIGRATION_VERSION;
      checks.migration = {
        ok: upToDate,
        latencyMs: Date.now() - migStart,
        error: upToDate
          ? undefined
          : `Ledger real: ${appliedName ?? "nenhuma migration registada"} · código espera: ${CURRENT_MIGRATION_FILE}`,
      };
    }
  } catch (e) {
    checks.migration = { ok: false, error: String(e) };
  }

  // ── Outbox (company_change_events) ───────────────────────────────────────────
  const outboxStart = Date.now();
  try {
    const { error } = await admin.from("company_change_events").select("id").limit(1);
    checks.outbox = { ok: !error, latencyMs: Date.now() - outboxStart, error: error?.message };
  } catch (e) {
    checks.outbox = { ok: false, error: String(e) };
  }

  // ── Rate limit distribuído ────────────────────────────────────────────────────
  const rateLimitConfigured = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
  );
  const isProd = deployEnv() === "production";
  checks.rateLimit = {
    ok: rateLimitConfigured || !isProd,
    error: rateLimitConfigured
      ? undefined
      : isProd
        ? "UPSTASH_REDIS_REST_URL/TOKEN em falta em produção — rate limit cai para memória local por instância (fail-open em serverless)."
        : "Rate limit em memória local (aceitável fora de produção).",
  };

  // ── Env vars essenciais ───────────────────────────────────────────────────────
  const requiredEnvs = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "RESEND_API_KEY",
    "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  ];
  const missingEnvs = requiredEnvs.filter((k) => !process.env[k]);
  checks.env = { ok: missingEnvs.length === 0, error: missingEnvs.length > 0 ? `Missing: ${missingEnvs.join(", ")}` : undefined };

  return {
    ok: Object.values(checks).every((c) => c.ok),
    checks,
    deploy: {
      commit: deployCommit(),
      branch: deployBranch(),
      env: deployEnv(),
      migrationVersion: CURRENT_MIGRATION_VERSION,
      supabaseProjectRef: supabaseProjectRef(),
    },
    ts: new Date().toISOString(),
  };
}
