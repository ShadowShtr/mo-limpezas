// ============================================================================
// RUNNER DE MIGRAÇÕES SEGURO
// ============================================================================
// Este ficheiro é só o wrapper de CLI: parsing de argumentos, carregamento
// de .env, criação do cliente `pg` real, e chamada ao núcleo em
// scripts/lib/migration-runner-core.mjs — que é onde vive toda a lógica que
// decide que queries correm (testável com um cliente falso, sem ligar a
// nenhuma base real, ver src/__tests__/migration-runner-core.test.ts).
//
// Substitui a versão antiga que:
//   - tinha a password do Postgres hardcoded (agora vem de SUPABASE_DB_URL);
//   - re-executava TODAS as migrações em cada run (migrações com UPDATE/DELETE
//     re-aplicavam-se e revertiam dados alterados entretanto);
//   - aplicava seed.sql (dados fictícios) contra a base de PRODUÇÃO;
//   - aplicava migrações por omissão, sem nenhuma flag (corrigido
//     2026-08-05, ver AGENTS.md REGRA ZERO secção 9 e
//     docs/PRODUCTION-RUNBOOK.md secção 8);
//   - o "dry-run" ainda executava CREATE TABLE/ALTER TABLE/UPDATE de
//     backfill de checksum antes de qualquer verificação de --dry-run —
//     corrigido 2026-08-05 (revisão pós-incidente da PR #32): agora TODA
//     mutação de schema/dados vive atrás de `apply === true` dentro do
//     núcleo (migration-runner-core.mjs), não só da flag da CLI;
//   - a confirmação de produção comparava a identidade da ligação por
//     SUBSTRING (`.includes()`) — corrigido para extração estruturada e
//     comparação exata do project ref (migration-runner-guards.mjs,
//     extractDbProjectRef).
//
// Regras:
//   - SEM ARGUMENTOS = dry-run. Sempre. Esquecer uma flag nunca escreve.
//   - dry-run executa EXCLUSIVAMENTE SELECT — nunca CREATE, ALTER, INSERT,
//     UPDATE, DELETE, BEGIN ou COMMIT.
//   - Escrever (aplicar pendentes, --baseline, --seed) exige --apply.
//   - --apply exige também --confirm-production <ref> com o project ref
//     exato de NEXT_PUBLIC_SUPABASE_URL, extraído estruturalmente de
//     SUPABASE_DB_URL (ligação direta ou pooler) — nunca por substring.
//   - Flags desconhecidas e combinações contraditórias (--dry-run+--apply,
//     --baseline+--seed) são rejeitadas antes de ligar à base.
//   - Tabela public._migrations regista o que já foi aplicado; só corre pendentes.
//   - Cada migração corre numa transação; ao 1º erro PÁRA (nada de engolir erros).
//
// Uso:
//   node scripts/run-migrations.mjs
//     → dry-run (nenhuma flag = seguro por omissão, só SELECT)
//   node scripts/run-migrations.mjs --apply --confirm-production <ref>
//     → aplica migrações pendentes
//   node scripts/run-migrations.mjs --baseline --apply --confirm-production <ref>
//     → marca tudo como aplicado SEM executar (1ª utilização numa base já existente)
//   node scripts/run-migrations.mjs --seed --apply --confirm-production <ref>
//     → seed.sql (só em base vazia/dev; recusa se companies > 0)
//   node scripts/run-migrations.mjs --apply --only 077_x.sql --confirm-production <ref>
//     → aplica EXATAMENTE essa migration. Correspondência exata do nome do
//       ficheiro; nunca prefixo, nunca "a partir de". Existe porque "aplicar
//       todas as pendentes" deixou de ser aceitável enquanto houver uma
//       migration congelada na fila — ver supabase/migration-policy.json,
//       blockedMigrations.
// ============================================================================

import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { assertNoDuplicateExceptions } from "./lib/migration-checksum.mjs";
import { assertValidBlockedEntries } from "./lib/migration-blocklist.mjs";
import {
  parseArgs,
  validateArgCombination,
  resolveProjectRef,
  extractDbProjectRef,
  validateProductionConfirmation,
} from "./lib/migration-runner-guards.mjs";
import { runMigrations } from "./lib/migration-runner-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const POLICY_FILE = join(ROOT, "supabase", "migration-policy.json");

const parsedArgs = parseArgs(process.argv.slice(2));
const combinationCheck = validateArgCombination(parsedArgs);
if (!combinationCheck.ok) {
  console.error(`❌ ${combinationCheck.error}`);
  process.exit(1);
}

const { apply: APPLY, baseline: BASELINE, seed: SEED, confirmProductionValue: CONFIRM_PRODUCTION_VALUE, onlyValue: ONLY } = parsedArgs;

// supabase/migration-policy.json é opcional aqui (só knownChecksumExceptions
// — este runner não tem o conceito de activeMigrations/frozenDrafts).
const policy = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : {};
const knownChecksumExceptions = policy.knownChecksumExceptions ?? [];
assertNoDuplicateExceptions(knownChecksumExceptions);
// Migrations deliberadamente congeladas. A política versionada é a fonte —
// nunca uma condição escrita no runner, que ninguém vê a desaparecer.
const blockedMigrations = policy.blockedMigrations ?? [];
assertValidBlockedEntries(blockedMigrations);

// .env.local (sem dependências externas)
for (const f of [".env.local", ".env"]) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("❌ Define SUPABASE_DB_URL no .env.local (connection string do Postgres, ver Supabase → Settings → Database).");
  console.error("   A password NUNCA deve voltar a estar escrita neste ficheiro.");
  process.exit(1);
}

const DB_HOST = new URL(DB_URL).hostname;
const DB_PROJECT_REF = extractDbProjectRef(DB_URL);
const PROJECT_REF = resolveProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log(`📍 Projeto: ${PROJECT_REF ?? "(desconhecido — NEXT_PUBLIC_SUPABASE_URL não definida)"}  |  Host: ${DB_HOST}  |  Modo: ${APPLY ? "APPLY (escreve)" : "dry-run"}`);

const productionConfirmation = validateProductionConfirmation({
  apply: APPLY,
  confirmProductionValue: CONFIRM_PRODUCTION_VALUE,
  projectRef: PROJECT_REF,
  dbProjectRef: DB_PROJECT_REF,
});
if (!productionConfirmation.ok) {
  console.error(`❌ ${productionConfirmation.error}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log("🔌 A conectar (SUPABASE_DB_URL)...");
  await client.connect();

  const { exitCode } = await runMigrations({
    client,
    migrationsDir: MIGRATIONS_DIR,
    rootDir: ROOT,
    apply: APPLY,
    baseline: BASELINE,
    seed: SEED,
    knownChecksumExceptions,
    blockedMigrations,
    only: ONLY,
  });

  await client.end();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error("Erro fatal:", err.message);
  try { await client.end(); } catch { /* noop */ }
  process.exit(1);
});
