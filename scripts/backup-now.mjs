// Backup manual via service-role key (mesma lógica/tabelas do endpoint
// autenticado /api/dashboard/backups/export, mas correntes sem sessão de
// browser). Gera um ZIP local antes de mexer em produção.
//
//   node scripts/backup-now.mjs

import { config } from "dotenv";
config({ path: ".env.local" });
import JSZip from "jszip";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY em .env.local");
  process.exit(1);
}
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const COMPANY_TABLES = [
  "clients", "locations", "teams", "contracts", "services", "timesheets",
  "absences", "vacation_requests", "company_settings", "invoices",
  "payroll_records", "cash_flow_entries", "client_notifications", "service_photos",
];
const PROFILES_COLUMNS = [
  "id", "company_id", "full_name", "avatar_url", "role", "status",
  "phone", "emergency_contact", "address", "nif", "iban",
  "skills", "hourly_rate", "hire_date", "notes", "created_at", "updated_at",
].join(",");

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

async function fetchAll(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: H });
  if (!res.ok) return { error: await res.text() };
  return await res.json();
}

async function main() {
  // Resolve a empresa via uma equipa conhecida (mesmo truque do import-predios.mjs).
  const teams0 = await fetchAll("teams", "select=company_id&limit=1");
  const companyId = Array.isArray(teams0) ? teams0[0]?.company_id : null;
  if (!companyId) { console.error("Não consegui resolver o company_id."); process.exit(1); }

  const zip = new JSZip();
  const exportedAt = new Date();
  const { data: companyRows } = await (await fetch(
    `${SUPABASE_URL}/rest/v1/companies?id=eq.${companyId}&select=id,name,slug,created_at`, { headers: H },
  )).json().then((d) => ({ data: d })).catch(() => ({ data: null }));
  const company = Array.isArray(companyRows) ? companyRows[0] : null;

  zip.file("manifest.json", JSON.stringify({
    app: "mo-limpezas",
    backup_version: 1,
    exported_at: exportedAt.toISOString(),
    company,
    exported_by: "script:backup-now.mjs (service role, antes da importação de prédios)",
    format: "json dentro de zip",
    restore_status: "preparado para restauracao futura; sem restore automatico nesta fase",
  }, null, 2));
  zip.file("README_RESTORE.txt", [
    "Backup Mo Limpezas (manual, via service role, antes de importar prédios)",
    "",
    "Este ficheiro ZIP contem exportacao operacional dos dados da empresa em JSON.",
    "Nesta fase nao existe botao de restore automatico na aplicacao.",
    "Para restauracao futura, validar manifest.json, schema da base de dados e importar tabela a tabela com controlo tecnico.",
    "Este backup local nao substitui os backups reais da infraestrutura/Supabase.",
    "",
  ].join("\n"));

  const datasets = {};
  for (const table of COMPANY_TABLES) {
    const data = await fetchAll(table, `select=*&company_id=eq.${companyId}`);
    datasets[table] = data;
    zip.file(`data/${table}.json`, JSON.stringify(data, null, 2));
  }

  const profiles = await fetchAll("profiles", `select=${PROFILES_COLUMNS}&company_id=eq.${companyId}`);
  datasets.profiles = profiles;
  zip.file("data/profiles.json", JSON.stringify(profiles, null, 2));

  const teamIds = (Array.isArray(datasets.teams) ? datasets.teams : []).map((t) => t.id);
  const serviceIds = (Array.isArray(datasets.services) ? datasets.services : []).map((s) => s.id);
  const invoiceIds = (Array.isArray(datasets.invoices) ? datasets.invoices : []).map((i) => i.id);

  zip.file("data/team_members.json", JSON.stringify(
    teamIds.length ? await fetchAll("team_members", `select=*&team_id=in.(${teamIds.join(",")})`) : [], null, 2,
  ));
  zip.file("data/service_reinforcements.json", JSON.stringify(
    serviceIds.length ? await fetchAll("service_reinforcements", `select=*&service_id=in.(${serviceIds.join(",")})`) : [], null, 2,
  ));
  zip.file("data/invoice_items.json", JSON.stringify(
    invoiceIds.length ? await fetchAll("invoice_items", `select=*&invoice_id=in.(${invoiceIds.join(",")})`) : [], null, 2,
  ));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const filename = `mo-limpezas-backup-pre-predios-${stamp(exportedAt)}.zip`;
  const outPath = path.join(homedir(), "Desktop", filename);
  await writeFile(outPath, buffer);
  console.log(`Backup criado: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => { console.error("Erro inesperado:", err); process.exit(1); });
