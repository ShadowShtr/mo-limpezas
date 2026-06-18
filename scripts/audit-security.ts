/**
 * Auditoria de segurança estática — executar em CI ou localmente.
 * Detecta: service role em client components, falta de company_id em queries.
 * Uso: npx tsx scripts/audit-security.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

let failures = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walkFiles(dir: string, exts = [".ts", ".tsx"]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      results.push(...walkFiles(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

function rel(path: string) { return relative(ROOT, path); }

function check(condition: boolean, file: string, message: string) {
  if (!condition) {
    console.error(`\n❌  ${rel(file)}\n    ${message}`);
    failures++;
  }
}

// ─── Regra 1: service role em client components ───────────────────────────────
// createAdminClient ou SUPABASE_SERVICE_ROLE_KEY NÃO devem aparecer em ficheiros
// com "use client" ou em componentes React (nomes que começam com maiúscula).

console.log('\n🔍  Verificando service role em client components...');
const clientFiles = walkFiles(SRC).filter((f) => {
  const content = readFileSync(f, "utf-8");
  return content.includes('"use client"');
});

for (const file of clientFiles) {
  const content = readFileSync(file, "utf-8");
  check(
    !content.includes("createAdminClient"),
    file,
    'Contém createAdminClient() num ficheiro "use client" — a service role nunca deve chegar ao browser.'
  );
  check(
    !content.includes("SUPABASE_SERVICE_ROLE_KEY"),
    file,
    'Referencia SUPABASE_SERVICE_ROLE_KEY num ficheiro "use client".'
  );
  check(
    !content.includes("supabase/admin"),
    file,
    'Importa @/lib/supabase/admin num ficheiro "use client".'
  );
}

// ─── Regra 2: company_id em server actions ────────────────────────────────────
// Todas as actions que fazem .from("services"|"timesheets"|"profiles"|"clients")
// com .eq() devem incluir company_id para garantir multi-tenancy.

console.log('\n🔍  Verificando company_id em server actions...');
const actionFiles = walkFiles(join(SRC, "app", "actions"));

const SENSITIVE_TABLES = ["services", "timesheets", "profiles", "clients", "locations", "teams", "invoices"];

for (const file of actionFiles) {
  const content = readFileSync(file, "utf-8");
  for (const table of SENSITIVE_TABLES) {
    const hasTable = content.includes(`.from("${table}")`);
    if (!hasTable) continue;
    const hasCompanyId = content.includes("company_id") || content.includes("companyId");
    check(
      hasCompanyId,
      file,
      `Faz query em "${table}" mas não menciona company_id — risco de cross-tenant data leak.`
    );
    break; // um aviso por ficheiro é suficiente
  }
}

// ─── Regra 3: API routes sem autenticação ─────────────────────────────────────

console.log('\n🔍  Verificando autenticação nas API routes...');
const apiFiles = walkFiles(join(SRC, "app", "api")).filter((f) => f.endsWith("route.ts"));

const CRON_ROUTES = ["cron", "keep-alive"];

for (const file of apiFiles) {
  const content = readFileSync(file, "utf-8");
  const isCron = CRON_ROUTES.some((p) => file.includes(p));

  if (isCron) {
    check(
      content.includes("CRON_SECRET"),
      file,
      "Rota cron sem verificação de CRON_SECRET."
    );
  } else {
    // Rotas normais devem verificar auth
    const hasAuth = content.includes("getUser()") || content.includes("auth.uid()") || file.includes("/health/");
    check(
      hasAuth,
      file,
      "Rota API sem verificação de utilizador (getUser/auth.uid). Verificar se é intencional."
    );
  }
}

// ─── Resultado ────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n🚫  ${failures} problema(s) de segurança encontrado(s). Revê os ficheiros acima.\n`);
  process.exit(1);
} else {
  console.log("\n✅  Auditoria de segurança concluída sem problemas.\n");
}
