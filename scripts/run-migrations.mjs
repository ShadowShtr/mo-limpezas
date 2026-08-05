// ============================================================================
// RUNNER DE MIGRAÇÕES SEGURO
// ============================================================================
// Substitui a versão antiga que:
//   - tinha a password do Postgres hardcoded (agora vem de SUPABASE_DB_URL);
//   - re-executava TODAS as migrações em cada run (migrações com UPDATE/DELETE
//     re-aplicavam-se e revertiam dados alterados entretanto);
//   - misturava dados de demonstração com alterações de schema.
//
// Regras:
//   - Tabela public._migrations regista o que já foi aplicado; só corre pendentes.
//   - Cada migração corre numa transação; ao 1º erro PÁRA (nada de engolir erros).
//   - A política em supabase/migration-policy.json decide explicitamente quais
//     ficheiros estão ativos e quais são rascunhos congelados.
//   - Não existe baseline automático nem execução de seed neste runner.
//
// Uso:
//   node scripts/run-migrations.mjs --dry-run    # mostra o que aplicaria
//   node scripts/run-migrations.mjs --apply      # aplica pendentes aprovadas
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const POLICY_FILE = join(ROOT, "supabase", "migration-policy.json");

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");
const unknownArgs = process.argv.slice(2).filter((arg) => !["--dry-run", "--apply"].includes(arg));
if (unknownArgs.length > 0) {
  console.error(`Argumentos não suportados: ${unknownArgs.join(", ")}`);
  process.exit(1);
}
if (DRY_RUN === APPLY) {
  console.error("Escolhe exatamente um modo: --dry-run ou --apply");
  process.exit(1);
}

const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
const frozenDrafts = new Map(policy.frozenDrafts.map((draft) => [draft.ledgerName, draft]));
const activeMigrations = new Set(policy.activeMigrations);
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

if (APPLY) {
  const confirmation = process.env.MIGRATION_CONFIRM_PROJECT_REF;
  const appRef = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1];
  if (!confirmation || !appRef || confirmation !== appRef) {
    console.error("MIGRATION_CONFIRM_PROJECT_REF deve coincidir com NEXT_PUBLIC_SUPABASE_URL antes de --apply.");
    process.exit(1);
  }

  const parsedDbUrl = new URL(DB_URL);
  const dbIdentity = `${parsedDbUrl.hostname} ${decodeURIComponent(parsedDbUrl.username)}`;
  if (!dbIdentity.includes(confirmation)) {
    console.error("A connection string não corresponde ao projeto confirmado.");
    process.exit(1);
  }
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
 * EOL — não recuperável do histórico Git (ver
 * docs/atomicidade-audit/migration-checksum-map-2026-08-05.md). Para essas,
 * e só essas, supabase/migration-policy.json pode declarar uma exceção
 * nomeada e pinada (nome exato + checksum do ledger exato + checksum
 * LF-normalizado do ficheiro atual exato); qualquer divergência num desses
 * três valores, ou uma segunda exceção para o mesmo ficheiro, invalida a
 * exceção e a migração volta a falhar como divergência normal.
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

function classifyFiles(files) {
  const unknown = files.filter((file) => !activeMigrations.has(file));
  const missing = policy.activeMigrations.filter((file) => !files.includes(file));

  if (unknown.length > 0 || missing.length > 0) {
    throw new Error([
      unknown.length > 0 ? `SQL sem classificação: ${unknown.join(", ")}` : null,
      missing.length > 0 ? `migrations ativas em falta: ${missing.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }

  return policy.activeMigrations;
}

async function main() {
  const allFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const files = classifyFiles(allFiles);

  for (const [ledgerName, draft] of frozenDrafts) {
    const draftContent = readFileSync(join(ROOT, draft.path), "utf8");
    // Mesma flexibilidade de EOL do ledger (ver migration-checksum.mjs):
    // um checkout novo pode normalizar este ficheiro para CRLF ou LF sem
    // que o conteúdo tenha mudado.
    if (!historicalChecksumMatches(draft.sha256, draftContent)) {
      throw new Error(`Rascunho congelado alterado: ${ledgerName}`);
    }
  }

  console.log("🔌 A conectar (SUPABASE_DB_URL)...");
  await client.connect();
  const { rows: trackingRows } = await client.query("SELECT to_regclass('public._migrations') AS table_name");
  const trackingExists = Boolean(trackingRows[0]?.table_name);
  if (DRY_RUN) {
    if (!trackingExists) throw new Error("public._migrations não existe; dry-run não altera o banco");
  } else {
    if (!trackingExists) {
      const { rows: schemaRows } = await client.query("SELECT to_regclass('public.companies') AS table_name");
      if (schemaRows[0]?.table_name) {
        throw new Error("Schema existente sem public._migrations; reconciliação manual obrigatória, nenhuma migration foi executada");
      }
    }
    await ensureTracking();
  }
  const applied = await appliedMap();

  if (applied.size === 0) {
    const { rows: schemaRows } = await client.query("SELECT to_regclass('public.companies') AS table_name");
    if (schemaRows[0]?.table_name) {
      throw new Error("Ledger vazio num schema existente; reconciliação manual obrigatória, nenhuma migration foi executada");
    }
  }

  const appliedFrozen = [...frozenDrafts.keys()].filter((file) => applied.has(file));
  if (appliedFrozen.length > 0) {
    throw new Error(`Rascunhos congelados aparecem no ledger: ${appliedFrozen.join(", ")}`);
  }

  const classified = new Set([...files, ...frozenDrafts.keys()]);
  const unknownApplied = [...applied.keys()].filter((file) => !classified.has(file));
  if (unknownApplied.length > 0) {
    throw new Error(`Ledger contém migrations desconhecidas: ${unknownApplied.join(", ")}`);
  }

  const withoutChecksum = [...applied.entries()]
    .filter(([name, sum]) => files.includes(name) && sum == null)
    .map(([name]) => name);
  if (withoutChecksum.length > 0) {
    throw new Error(`Ledger sem checksum; requer reconciliação manual revista: ${withoutChecksum.join(", ")}`);
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

  const pending = files.filter((f) => !applied.has(f));
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

  await client.end();
  console.log("🎉 Concluído.");
}

main().catch(async (err) => {
  console.error("Erro fatal:", err.message);
  try { await client.end(); } catch { /* noop */ }
  process.exit(1);
});
