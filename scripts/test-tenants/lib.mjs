// ============================================================================
// LIB PARTILHADA — tenants de teste isolados no projeto Supabase de PRODUÇÃO
// ============================================================================
// Usado por provision.mjs, verify-isolation.mjs e cleanup.mjs. Não faz
// nenhuma escrita por si só — só validação de ambiente, clientes Supabase,
// e helpers de máscara/log. Ver docs/atomicidade-audit/migration-checksum-map-2026-08-05.md
// e o relatório de bloqueio de isolamento multiempresa (2026-08-05) para o
// contexto de por que 068/069 tiveram de ser aplicadas antes disto existir.
//
// Regra dura em todo este diretório: nunca imprimir email, password, token,
// JWT, UUID real de empresa/utilizador, ou qualquer linha de dados
// devolvida por uma query. Só PASS/FAIL com descrição segura, e valores
// mascarados quando é preciso mostrar alguma coisa para diagnóstico.
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

// ── Slugs reservados — únicos identificadores aceites para localizar os
//    tenants de teste. Nunca por nome, nunca por correspondência parcial. ──
export const TENANT_A_SLUG = "mo-testes-atomicidade";
export const TENANT_B_SLUG = "teste-isolamento-tenant";
export const TEST_SLUGS = Object.freeze([TENANT_A_SLUG, TENANT_B_SLUG]);

export const TENANT_A_NAME = "MO Testes Atomicidade";
export const TENANT_B_NAME = "Teste Isolamento Tenant";

export const SYNTHETIC_PREFIX = "TESTE_ISOLAMENTO_";

// ── Carregamento de .env.test-tenants.local (sem dependências externas,
//    mesmo padrão do scripts/run-migrations.mjs) ──────────────────────────
export function loadTestTenantsEnv() {
  for (const f of [".env.test-tenants.local", ".env.local", ".env"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

/**
 * Valida que todas as variáveis pedidas existem e não estão vazias.
 * Nunca imprime o valor — só o nome, em caso de falta.
 */
export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n] || process.env[n].trim() === "");
  if (missing.length > 0) {
    throw new Error(`Variáveis de ambiente em falta: ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

// ── Máscara — nunca imprimir o valor real ──────────────────────────────────
export function maskEmail(email) {
  if (!email) return "(vazio)";
  const [user, domain] = String(email).split("@");
  if (!domain) return "***";
  const u = user.length <= 2 ? user[0] + "*" : user.slice(0, 2) + "*".repeat(Math.max(1, user.length - 2));
  const domainParts = domain.split(".");
  const d = domainParts[0].length <= 1 ? "*" : domainParts[0][0] + "*".repeat(Math.max(1, domainParts[0].length - 1));
  return `${u}@${d}.${domainParts.slice(1).join(".")}`;
}

export function maskUuid(uuid) {
  if (!uuid) return "(vazio)";
  const s = String(uuid);
  return s.length <= 8 ? "…" : s.slice(0, 8) + "…";
}

/** Hash curto e não reversível — só para comparar "é a mesma empresa?" nos logs, nunca o slug/UUID real. */
export function fingerprint(value) {
  if (!value) return "(vazio)";
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

// ── Clientes Supabase ───────────────────────────────────────────────────────

/** Cliente admin (service_role) — só em provision.mjs e cleanup.mjs, nunca em verify-isolation.mjs. */
export function makeAdminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Cliente anon NOVO e isolado, sem sessão nem storage partilhado com
 * qualquer outra instância — cada conta de teste usa a sua própria, para
 * que uma sessão nunca vaze para outra (verify-isolation.mjs).
 */
export function makeAnonClient() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = requireEnv(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, storage: new MemoryStorage() },
  });
}

/** Storage em memória, isolado por instância — nunca toca em localStorage/ficheiros. */
class MemoryStorage {
  constructor() { this.store = new Map(); }
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }
  setItem(key, value) { this.store.set(key, value); }
  removeItem(key) { this.store.delete(key); }
}

// ── run_id — identifica os dados sintéticos criados por uma execução de
//    verify-isolation.mjs, para o cleanup no finally apagar só os seus. ────
export function genRunId() {
  return randomUUID();
}

export function syntheticName(runId, label) {
  return `${SYNTHETIC_PREFIX}${label}_${runId.slice(0, 8)}`;
}

// ── Resultado de testes — só PASS/FAIL com descrição segura ────────────────
export class TestResults {
  constructor() {
    this.results = [];
  }
  pass(description) {
    this.results.push({ ok: true, description });
    console.log(`PASS — ${description}`);
  }
  fail(description) {
    this.results.push({ ok: false, description });
    console.log(`FAIL — ${description}`);
  }
  /** Nunca passar o erro completo — só uma descrição já sanitizada pelo chamador. */
  failFromError(description, err) {
    this.fail(`${description} (erro: ${safeErrorMessage(err)})`);
  }
  hasFailures() {
    return this.results.some((r) => !r.ok);
  }
  summary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.ok).length;
    return { total, passed, failed: total - passed };
  }
  /** Regista PASS/FAIL a partir de uma condição booleana, sem ternário-como-statement. */
  report(cond, description, failDescription) {
    if (cond) this.pass(description);
    else this.fail(failDescription ?? description);
  }
}

/**
 * Mensagem de erro segura para log: só a `message` do erro Postgres/Supabase
 * (já sem tokens), nunca o objeto completo (pode conter headers/JWT).
 */
export function safeErrorMessage(err) {
  if (!err) return "erro desconhecido";
  const msg = typeof err === "string" ? err : err.message || err.error_description || err.error || "erro sem mensagem";
  // remove qualquer coisa que pareça um JWT (3 blocos base64 separados por ".")
  return String(msg).replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt-redacted]");
}
