// ============================================================================
// RUNNER DE MIGRAÇÕES SEGURO
// ============================================================================
// Substitui a versão antiga que:
//   - tinha a password do Postgres hardcoded (agora vem de SUPABASE_DB_URL);
//   - re-executava TODAS as migrações em cada run (migrações com UPDATE/DELETE
//     re-aplicavam-se e revertiam dados alterados entretanto);
//   - aplicava seed.sql (dados fictícios) contra a base de PRODUÇÃO.
//
// Regras:
//   - Tabela public._migrations regista o que já foi aplicado; só corre pendentes.
//   - Cada migração corre numa transação; ao 1º erro PÁRA (nada de engolir erros).
//   - Primeira utilização numa base já existente: `--baseline` marca tudo como
//     aplicado SEM executar (obrigatório antes do primeiro run normal).
//   - seed.sql só com `--seed`, e recusa se a base já tiver dados.
//
// Uso:
//   SUPABASE_DB_URL=postgres://... node scripts/run-migrations.mjs --baseline
//   node scripts/run-migrations.mjs              # aplica pendentes
//   node scripts/run-migrations.mjs --dry-run    # mostra o que aplicaria
//   node scripts/run-migrations.mjs --seed       # (só em base vazia/dev)
// ============================================================================

import pg from "pg";
import { createHash } from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

const BASELINE = process.argv.includes("--baseline");
const DRY_RUN = process.argv.includes("--dry-run");
const SEED = process.argv.includes("--seed");

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

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const checksumOf = (sql) => createHash("sha256").update(sql).digest("hex");

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
 */
function verifyChecksums(applied, files) {
  const divergent = [];
  for (const file of files) {
    const stored = applied.get(file);
    if (stored == null) continue; // pendente ou registada sem checksum (pré-upgrade)
    const current = checksumOf(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    if (stored !== current) divergent.push(file);
  }
  return divergent;
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
      const cs = checksumOf(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
      await client.query(
        "UPDATE public._migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL",
        [cs, name],
      );
      applied.set(name, cs);
      console.log(`🔏 checksum backfill: ${name}`);
    }
  }

  // Migração já aplicada cujo ficheiro mudou → parar SEMPRE (nada de silêncio).
  const divergent = verifyChecksums(applied, files);
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
    for (const f of files) {
      if (!applied.has(f)) {
        const sum = checksumOf(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
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
      await client.query("INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)", [file, checksumOf(sql)]);
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
