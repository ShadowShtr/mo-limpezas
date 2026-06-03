import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../supabase/migrations");
const SEED_FILE = join(__dirname, "../supabase/seed.sql");
const OUTPUT = join(__dirname, "../supabase/APPLY_ALL.sql");

// As policies da migration 001 referenciam 'profiles' que só existe depois.
// Vamos extraí-las e colocá-las após a migration 002.
const DEFERRED_POLICIES = `
-- ============================================================
-- POLICIES companies/company_settings (diferidas — dependem de profiles)
-- ============================================================
CREATE POLICY "users see own company" ON companies
  FOR SELECT USING (
    id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "users see own company settings" ON company_settings
  FOR SELECT USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "admins manage company settings" ON company_settings
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );
`;

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

let combined = `-- ============================================================
-- ESCALA — APPLY ALL MIGRATIONS + SEED (versão corrigida)
-- ============================================================

-- Limpar tudo antes de começar (seguro reexecutar)
DROP VIEW IF EXISTS teams_with_members CASCADE;
DROP VIEW IF EXISTS monthly_hours_summary CASCADE;
DROP VIEW IF EXISTS services_full CASCADE;
DROP TABLE IF EXISTS push_subscriptions CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS payroll_records CASCADE;
DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS vacation_requests CASCADE;
DROP TABLE IF EXISTS absences CASCADE;
DROP TABLE IF EXISTS timesheets CASCADE;
DROP TABLE IF EXISTS service_price_audit CASCADE;
DROP TABLE IF EXISTS service_reinforcements CASCADE;
DROP TABLE IF EXISTS services CASCADE;
DROP TABLE IF EXISTS contracts CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS locations CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS company_settings CASCADE;
DROP TABLE IF EXISTS companies CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
DROP FUNCTION IF EXISTS handle_new_user CASCADE;
DROP FUNCTION IF EXISTS generate_reference_number CASCADE;
DROP SEQUENCE IF EXISTS service_reference_seq CASCADE;

\n`;

for (const file of files) {
  let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

  // Remove as 3 policies do 001 que dependem de profiles
  if (file === "001_companies.sql") {
    sql = sql
      .replace(/CREATE POLICY "users see own company" ON companies[\s\S]*?;/g, "-- [policy movida para depois de 002]")
      .replace(/CREATE POLICY "users see own company settings" ON company_settings[\s\S]*?;/g, "-- [policy movida para depois de 002]")
      .replace(/CREATE POLICY "admins manage company settings" ON company_settings[\s\S]*?;/g, "-- [policy movida para depois de 002]");
  }

  combined += `-- ============================================================\n`;
  combined += `-- ${file}\n`;
  combined += `-- ============================================================\n`;
  combined += sql;
  combined += `\n\n`;

  // Após 002 (profiles criado), injetar as policies diferidas
  if (file === "002_profiles.sql") {
    combined += DEFERRED_POLICIES + "\n\n";
  }
}

combined += `-- ============================================================\n`;
combined += `-- SEED\n`;
combined += `-- ============================================================\n`;
combined += readFileSync(SEED_FILE, "utf8");

writeFileSync(OUTPUT, combined, "utf8");
console.log(`✅ APPLY_ALL.sql corrigido criado (${(combined.length / 1024).toFixed(1)} KB)`);
console.log("   Policies de companies/company_settings movidas para depois de profiles.");
