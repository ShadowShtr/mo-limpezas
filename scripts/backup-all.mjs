// Backup COMPLETO de todas as tabelas → CSV (legível) + JSON (restauro fiel).
// Usa a service role key (ignora RLS → apanha TODOS os registos).
// NÃO altera nada. Cria uma pasta backups/<timestamp>/.
//
//   node scripts/backup-all.mjs
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const env = fs.readFileSync(".env.local", "utf8").split("\n").reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2].replace(/^"|"$/g, "");
  return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Todas as tabelas (ordem: pais antes de filhos, útil para restauro).
const TABLES = [
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
  "audit_logs", "background_jobs",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

async function fetchAll(table) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) return { error };
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return { data: all };
}

const stamp = process.argv[2] || "manual";
const dir = path.join("backups", stamp);
fs.mkdirSync(dir, { recursive: true });

const manifest = { url: env.NEXT_PUBLIC_SUPABASE_URL, tables: {}, total: 0, errors: {} };
for (const t of TABLES) {
  const { data, error } = await fetchAll(t);
  if (error) {
    manifest.errors[t] = error.message;
    console.log(`⚠️  ${t}: ${error.message}`);
    continue;
  }
  fs.writeFileSync(path.join(dir, `${t}.csv`), toCsv(data));
  fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(data, null, 2));
  manifest.tables[t] = data.length;
  manifest.total += data.length;
  console.log(`✅ ${t}: ${data.length} registos`);
}
fs.writeFileSync(path.join(dir, "_MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`\n📦 Backup em ${dir} — ${manifest.total} registos totais.`);
if (Object.keys(manifest.errors).length) {
  console.log(`Tabelas com erro: ${Object.keys(manifest.errors).join(", ")}`);
}
