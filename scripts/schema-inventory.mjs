// ============================================================================
// INVENTÁRIO DE SCHEMA — SOMENTE LEITURA
// ============================================================================
// Parte do T03 do plano de correção: como não há pg_dump/psql nem projeto
// Supabase descartável disponíveis neste ambiente, este script usa a mesma
// connection string (SUPABASE_DB_URL) que scripts/run-migrations.mjs já usa,
// mas SÓ executa SELECT — nunca DDL, nunca escreve, nunca precisa de
// confirmação de projeto porque não pode alterar nada.
//
// Produz um snapshot estruturado de: tabelas/colunas, constraints, índices,
// funções (incl. security definer/search_path), triggers, políticas RLS,
// extensões, publicação Realtime, grants de funções sensíveis, contagens de
// linhas por tabela, utilizadores Auth e buckets de Storage.
//
// Uso:
//   node scripts/schema-inventory.mjs > docs/atomicidade-audit/schema-inventory-<data>.json
// ============================================================================

import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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

const DATA_TABLES = [
  "companies", "company_settings", "profiles", "clients", "locations",
  "teams", "team_members", "vehicles", "vehicle_allocations",
  "collaborator_ride_assignments", "contracts", "services",
  "service_reinforcements", "service_price_audit", "service_photos",
  "timesheets", "daily_clocks", "absences", "vacation_requests",
  "management_tasks", "collaborator_documents",
  "bank_accounts", "bank_transactions", "bank_statement_imports",
  "bank_reconciliation_matches", "cash_flow_entries",
  "fixed_variable_payments", "payroll_records", "invoices", "invoice_items",
  "client_notifications", "notifications", "push_subscriptions",
  "audit_logs", "background_jobs", "building_cards", "data_history",
];

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  const hostOnly = new URL(DB_URL).hostname;
  const report = { generatedAt: new Date().toISOString(), dbHost: hostOnly };

  report.migrationsLedger = (await client.query(
    "SELECT name, checksum, applied_at FROM public._migrations ORDER BY name",
  )).rows;

  report.revisionColumns = (await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'revision'
    ORDER BY table_name
  `)).rows;

  report.revisionTriggers = (await client.query(`
    SELECT c.relname AS table_name, t.tgname AS trigger_name, p.proname AS function_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  `)).rows;

  report.securityDefinerFunctions = (await client.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS security_definer, p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
    ORDER BY p.proname
  `)).rows;

  report.functionGrants = (await client.query(`
    SELECT routine_name, grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND grantee IN ('anon', 'authenticated', 'PUBLIC', 'service_role')
    ORDER BY routine_name, grantee
  `)).rows;

  report.rlsStatus = (await client.query(`
    SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY relname
  `)).rows;

  report.policies = (await client.query(`
    SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `)).rows;

  report.extensions = (await client.query(
    "SELECT extname, extversion FROM pg_extension ORDER BY extname",
  )).rows;

  report.realtimePublication = (await client.query(`
    SELECT schemaname, tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    ORDER BY tablename
  `)).rows;

  report.tableCounts = {};
  for (const t of DATA_TABLES) {
    try {
      const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM public.${client.escapeIdentifier(t)}`);
      report.tableCounts[t] = Number(rows[0].n);
    } catch (e) {
      report.tableCounts[t] = { error: String(e.message ?? e) };
    }
  }

  try {
    const { rows } = await client.query("SELECT count(*)::bigint AS n FROM auth.users");
    report.authUsersCount = Number(rows[0].n);
  } catch (e) {
    report.authUsersCount = { error: String(e.message ?? e) };
  }

  try {
    const { rows } = await client.query("SELECT id, name, public FROM storage.buckets ORDER BY id");
    report.storageBuckets = rows;
  } catch (e) {
    report.storageBuckets = { error: String(e.message ?? e) };
  }

  try {
    const { rows } = await client.query(`
      SELECT conname, conrelid::regclass::text AS table_name, confrelid::regclass::text AS references_table
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      ORDER BY conrelid::regclass::text, conname
    `);
    report.foreignKeyCount = rows.length;
  } catch (e) {
    report.foreignKeyCount = { error: String(e.message ?? e) };
  }

  console.log(JSON.stringify(report, null, 2));
  await client.end();
}

main().catch((e) => {
  console.error(String(e.stack ?? e));
  process.exit(1);
});
