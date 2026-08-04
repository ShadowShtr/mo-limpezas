import { createAdminClient } from "@/lib/supabase/admin";
import { deployBranch, deployCommit, deployEnv, supabaseProjectRef } from "@/lib/deploy-info";
import {
  CURRENT_SCHEMA_BASELINE,
  EXPECTED_APPLIED_MIGRATION_COUNT,
  evaluateMigrationLedger,
} from "@/lib/migration-policy";

export interface HealthCheck {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  warning?: string;
}

export interface DeepHealthReport {
  ok: boolean;
  checks: Record<string, HealthCheck>;
  deploy: {
    commit: string;
    branch: string | null;
    env: string;
    migrationBaseline: string;
    expectedAppliedMigrations: number;
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
      .select("name");
    if (error) {
      checks.migration = { ok: false, latencyMs: Date.now() - migStart, error: error.message };
    } else {
      const appliedNames = ((data ?? []) as Array<{ name: string }>).map((row) => row.name);
      const ledger = evaluateMigrationLedger(appliedNames);
      const details = [
        ledger.missing.length > 0 ? `migrations em falta: ${ledger.missing.join(", ")}` : null,
        ledger.appliedFrozenDrafts.length > 0 ? `rascunhos congelados registados: ${ledger.appliedFrozenDrafts.join(", ")}` : null,
        ledger.unexpected.length > 0 ? `migrations desconhecidas: ${ledger.unexpected.join(", ")}` : null,
      ].filter(Boolean);
      checks.migration = {
        ok: ledger.ok,
        latencyMs: Date.now() - migStart,
        error: ledger.ok ? undefined : details.join("; "),
      };
    }
  } catch (e) {
    checks.migration = { ok: false, error: String(e) };
  }

  // ── Outbox (company_change_events) ───────────────────────────────────────────
  const outboxStart = Date.now();
  try {
    const { error } = await admin.from("company_change_events").select("id").limit(1);
    checks.outbox = {
      ok: !error,
      latencyMs: Date.now() - outboxStart,
      error: error?.message,
      warning: error
        ? undefined
        : "Estrutura parcial presente; sincronização por outbox permanece desativada até reconciliação formal.",
    };
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
      migrationBaseline: CURRENT_SCHEMA_BASELINE,
      expectedAppliedMigrations: EXPECTED_APPLIED_MIGRATION_COUNT,
      supabaseProjectRef: supabaseProjectRef(),
    },
    ts: new Date().toISOString(),
  };
}
