// ============================================================================
// RUNNER DE MIGRAÇÕES SEGURO
// ============================================================================
// Substitui a versão antiga que:
//   - tinha a password do Postgres hardcoded (agora vem de SUPABASE_DB_URL);
//   - re-executava TODAS as migrações em cada run (migrações com UPDATE/DELETE
//     re-aplicavam-se e revertiam dados alterados entretanto);
//   - aplicava seed.sql (dados fictícios) contra a base de PRODUÇÃO;
//   - **aplicava migrações por omissão, sem nenhuma flag** (corrigido
//     2026-08-05, ver AGENTS.md REGRA ZERO secção 9 e
//     docs/PRODUCTION-RUNBOOK.md secção 8 — nenhum script de escrita pode
//     ter produção como comportamento por omissão).
//
// Regras:
//   - SEM ARGUMENTOS = dry-run. Sempre. Esquecer uma flag nunca escreve.
//   - Escrever (aplicar pendentes, --baseline, --seed) exige --apply.
//   - --apply exige também --confirm-production <ref> com o project ref
//     exato de NEXT_PUBLIC_SUPABASE_URL — confirma visualmente que sabes
//     em que projeto estás a escrever antes de o fazeres.
//   - Flags desconhecidas e combinações contraditórias (--dry-run+--apply,
//     --baseline+--seed) são rejeitadas antes de ligar à base.
//   - Tabela public._migrations regista o que já foi aplicado; só corre pendentes.
//   - Cada migração corre numa transação; ao 1º erro PÁRA (nada de engolir erros).
//
// Uso:
//   node scripts/run-migrations.mjs
//     → dry-run (nenhuma flag = seguro por omissão)
//   node scripts/run-migrations.mjs --apply --confirm-production <ref>
//     → aplica migrações pendentes
//   node scripts/run-migrations.mjs --baseline --apply --confirm-production <ref>
//     → marca tudo como aplicado SEM executar (1ª utilização numa base já existente)
//   node scripts/run-migrations.mjs --seed --apply --confirm-production <ref>
//     → seed.sql (só em base vazia/dev; recusa se companies > 0)
// ============================================================================

import pg from "pg";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  historicalChecksumMatches,
  checksumForNewMigration,
  assertNoDuplicateExceptions,
  findKnownException,
  knownExceptionMatches,
} from "./lib/migration-checksum.mjs";
import {
  parseArgs,
  validateArgCombination,
  resolveProjectRef,
  dbIdentityFromUrl,
  validateProductionConfirmation,
} from "./lib/migration-runner-guards.mjs";

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

const { apply: APPLY, baseline: BASELINE, seed: SEED, confirmProductionValue: CONFIRM_PRODUCTION_VALUE } = parsedArgs;
// Sem --apply é SEMPRE dry-run — mesmo sem --dry-run explícito na linha de comandos.
const DRY_RUN = !APPLY;

// supabase/migration-policy.json é opcional aqui (só knownChecksumExceptions
// — este runner não tem o conceito de activeMigrations/frozenDrafts).
const policy = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : {};
const knownChecksumExceptions = policy.knownChecksumExceptions ?? [];
assertNoDuplicateExceptions(knownChecksumExceptions);

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
const DB_IDENTITY = dbIdentityFromUrl(DB_URL);
const PROJECT_REF = resolveProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log(`📍 Projeto: ${PROJECT_REF ?? "(desconhecido — NEXT_PUBLIC_SUPABASE_URL não definida)"}  |  Host: ${DB_HOST}  |  Modo: ${APPLY ? "APPLY (escreve)" : "dry-run"}`);

const productionConfirmation = validateProductionConfirmation({
  apply: APPLY,
  confirmProductionValue: CONFIRM_PRODUCTION_VALUE,
  projectRef: PROJECT_REF,
  dbIdentity: DB_IDENTITY,
});
if (!productionConfirmation.ok) {
  console.error(`❌ ${productionConfirmation.error}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function ensureTracking() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Bases que criaram a tabela antes do checksum existir.
  await client.query("ALTER TABLE public._migrations ADD COLUMN IF NOT EXISTS checksum text");
}

async function appliedMap() {
  const { rows } = await client.query("SELECT name, checksum FROM public._migrations");
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

/**
 * Uma migração já aplicada NUNCA pode mudar de conteúdo — se o ficheiro local
 * divergir do checksum registado, ou alguém editou um .sql histórico (e a base
 * ficou diferente do que o repo diz) ou o histórico foi reescrito. Em ambos os
 * casos é preciso intervenção humana, não silêncio.
 *
 * O ledger mistura checksums calculados sobre LF e sobre CRLF, ficheiro a
 * ficheiro (checkouts em máquinas/OS diferentes ao longo dos anos, antes de
 * existir .gitattributes — ver
 * docs/atomicidade-audit/migration-checksum-map-2026-08-05.md). Por isso uma
 * migração histórica é aceite se o checksum guardado bater com o RAW, o
 * LF-normalizado ou o CRLF-normalizado do ficheiro atual; só uma alteração
 * real de conteúdo (nenhuma das três) continua a falhar.
 *
 * Um número muito pequeno de migrações (hoje: só a 022) foi editado depois
 * de aplicado sem que o conteúdo real batesse com nenhuma representação de
 * EOL — não recuperável do histórico Git. Para essas, e só essas,
 * supabase/migration-policy.json pode declarar uma exceção nomeada e pinada
 * (nome exato + checksum do ledger exato + checksum LF-normalizado do
 * ficheiro atual exato); qualquer divergência num desses três valores, ou
 * uma segunda exceção para o mesmo ficheiro, invalida a exceção.
 */
function verifyChecksums(applied, files) {
  const divergent = [];
  const accepted = [];
  for (const file of files) {
    const stored = applied.get(file);
    if (stored == null) continue; // pendente ou registada sem checksum (pré-upgrade)
    const current = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (historicalChecksumMatches(stored, current)) continue;

    const exception = findKnownException(knownChecksumExceptions, file);
    if (knownExceptionMatches(exception, stored, current)) {
      accepted.push({ file, reason: exception.reason });
      continue;
    }
    divergent.push(file);
  }
  return { divergent, accepted };
}

async function dbHasData() {
  try {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM public.companies");
    return rows[0].n > 0;
  } catch {
    return false; // tabela nem existe → base vazia
  }
}

async function main() {
  console.log("🔌 A conectar (SUPABASE_DB_URL)...");
  await client.connect();
  await ensureTracking();

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const applied = await appliedMap();

  // Backfill: registos criados antes do checksum existir recebem o checksum do
  // ficheiro atual (mesma assunção do --baseline: o ficheiro não mudou desde a
  // aplicação). A partir daí qualquer edição futura é detetada.
  for (const [name, sum] of applied) {
    if (sum == null && files.includes(name)) {
      const cs = checksumForNewMigration(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
      await client.query(
        "UPDATE public._migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL",
        [cs, name],
      );
      applied.set(name, cs);
      console.log(`🔏 checksum backfill: ${name}`);
    }
  }

  // Migração já aplicada cujo ficheiro mudou → parar SEMPRE (nada de silêncio).
  const { divergent, accepted } = verifyChecksums(applied, files);
  for (const { file, reason } of accepted) {
    console.warn("⚠ CHECKSUM EXCEPTION ACEITE:");
    console.warn(`   ${file}`);
    console.warn(`   Motivo: ${reason}`);
  }
  if (divergent.length > 0) {
    console.error("❌ CHECKSUM DIVERGENTE — estes ficheiros de migração foram ALTERADOS depois de aplicados:");
    for (const f of divergent) console.error(`   - ${f}`);
    console.error("   A base pode não corresponder ao que o repo diz. Reverte a alteração ao ficheiro,");
    console.error("   ou cria uma migração NOVA com a correção (nunca editar migrações históricas).");
    await client.end();
    process.exit(1);
  }

  // Guarda: base com schema mas sem histórico de migrações → exigir baseline.
  if (!BASELINE && applied.size === 0 && (await dbHasData())) {
    console.error("❌ Esta base já tem dados mas a tabela _migrations está vazia.");
    console.error("   Corre primeiro:  node scripts/run-migrations.mjs --baseline");
    console.error("   (marca as migrações existentes como aplicadas SEM as re-executar — evita re-aplicar UPDATEs/DELETEs sobre dados reais)");
    await client.end();
    process.exit(1);
  }

  if (BASELINE) {
    const toBaseline = files.filter((f) => !applied.has(f));
    console.log(`📋 ${toBaseline.length} migração(ões) a marcar como aplicada(s) (baseline, sem executar): ${toBaseline.join(", ") || "(nenhuma)"}`);
    for (const f of files) {
      if (!applied.has(f)) {
        const sum = checksumForNewMigration(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
        await client.query(
          "INSERT INTO public._migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum",
          [f, sum],
        );
        console.log(`📌 baseline: ${f}`);
      }
    }
    console.log("✅ Baseline concluído — nada foi executado, tudo marcado como aplicado (com checksum).");
    await client.end();
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  console.log(`📋 ${pending.length} migração(ões) pendente(s)${pending.length > 0 ? ": " + pending.join(", ") : ""}`);
  if (pending.length === 0) {
    console.log("✅ Nenhuma migração pendente.");
  }
  for (const file of pending) {
    if (DRY_RUN) { console.log(`(dry-run) aplicaria: ${file}`); continue; }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`📦 ${file}...`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)", [file, checksumForNewMigration(sql)]);
      await client.query("COMMIT");
      console.log("   ✅ OK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`   ❌ ERRO em ${file}: ${err.message}`);
      console.error("   Migração revertida (transação). Corrige o .sql e volta a correr — nada ficou a meio.");
      await client.end();
      process.exit(1);
    }
  }

  if (SEED) {
    if (await dbHasData()) {
      console.error("❌ --seed recusado: a base já tem dados (companies > 0). O seed é APENAS para bases de desenvolvimento vazias.");
      await client.end();
      process.exit(1);
    }
    if (!DRY_RUN) {
      console.log("🌱 seed.sql (base vazia confirmada)...");
      await client.query(readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8"));
      console.log("✅ Seed aplicado.");
    }
  }

  await client.end();
  console.log("🎉 Concluído.");
}

main().catch(async (err) => {
  console.error("Erro fatal:", err.message);
  try { await client.end(); } catch { /* noop */ }
  process.exit(1);
});
