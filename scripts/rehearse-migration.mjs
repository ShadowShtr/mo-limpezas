// ============================================================================
// ENSAIO TRANSACIONAL DE MIGRATION — BEGIN ... ROLLBACK
// ============================================================================
// Runbook (docs/MIGRATIONS-RUNBOOK.md), passo 8: "executar ensaio com BEGIN,
// verificações e ROLLBACK, apenas em janela controlada". Este script:
//   1. abre uma transação na base real (SUPABASE_DB_URL);
//   2. corre o SQL da migration indicada;
//   3. corre a query de verificação indicada (opcional);
//   4. faz SEMPRE ROLLBACK — nunca COMMIT — mesmo em caso de sucesso;
//   5. confirma, numa segunda ligação, que nada mudou de facto.
//
// NUNCA aplica a migration de vez. Isso é scripts/run-migrations.mjs --apply,
// um passo separado que exige autorização explícita (runbook, secção
// "Aplicação definitiva").
//
// Uso:
//   node scripts/rehearse-migration.mjs <ficheiro.sql> [verify.sql]
// ============================================================================

import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

const [, , migrationFile, verifyFile] = process.argv;
if (!migrationFile) {
  console.error("Uso: node scripts/rehearse-migration.mjs <ficheiro.sql> [verify.sql]");
  process.exit(1);
}

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
  console.error("Define SUPABASE_DB_URL no .env.local.");
  process.exit(1);
}

const migrationPath = join(MIGRATIONS_DIR, migrationFile);
if (!existsSync(migrationPath)) {
  console.error(`Migration não encontrada: ${migrationPath}`);
  process.exit(1);
}
const sql = readFileSync(migrationPath, "utf8");

async function grantSnapshot(client) {
  const functionGrants = (await client.query(`
    SELECT routine_name, grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('record_company_change_event', 'delete_client_atomic', 'set_invoice_status_atomic')
    ORDER BY routine_name, grantee
  `)).rows;
  const tableGrants = (await client.query(`
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('domain_mutations', 'company_change_events', 'company_sync_state')
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ORDER BY table_name, grantee, privilege_type
  `)).rows;
  return JSON.stringify({ functionGrants, tableGrants });
}

async function main() {
  const preClient = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await preClient.connect();
  const before = await grantSnapshot(preClient);
  await preClient.end();
  console.log("📸 Fingerprint (grants de funções + tabelas do outbox) ANTES do ensaio capturado.");

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`🔌 Ligado. A abrir transação para ensaiar ${migrationFile}...`);

  try {
    await client.query("BEGIN");
    await client.query(sql);
    console.log("✅ Migration executou sem erro dentro da transação.");

    const snapshotInTx = JSON.parse(await grantSnapshot(client));
    console.log(`🔍 Estado dentro da transação — grants de função: ${snapshotInTx.functionGrants.length}, grants de tabela (anon/authenticated/PUBLIC): ${snapshotInTx.tableGrants.length}.`);
    console.log(snapshotInTx);

    if (verifyFile) {
      const verifyPath = join(MIGRATIONS_DIR, verifyFile);
      if (existsSync(verifyPath)) {
        const verifySql = readFileSync(verifyPath, "utf8");
        const verifyResult = await client.query(verifySql);
        console.log("🔍 Verificação adicional:", verifyResult.rows);
      }
    }
  } catch (e) {
    console.error("❌ Erro durante o ensaio:", e.message);
  } finally {
    await client.query("ROLLBACK");
    console.log("↩️  ROLLBACK executado — nada foi persistido.");
    await client.end();
  }

  const postClient = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await postClient.connect();
  const after = await grantSnapshot(postClient);
  await postClient.end();

  const identical = before === after;
  console.log(identical
    ? "✅ Fingerprint DEPOIS do ensaio é idêntico ao de ANTES — ROLLBACK confirmado eficaz."
    : "🚨 Fingerprint DIVERGENTE depois do ensaio — investigar antes de qualquer aplicação real.");
  if (!identical) {
    console.log("ANTES:", before);
    console.log("DEPOIS:", after);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e.stack ?? e));
  process.exit(1);
});
