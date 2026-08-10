// Restauro genérico a partir de um backup gerado por backup-all.mjs
// (pasta backups/<stamp>/ com _MANIFEST.json + <tabela>.json por tabela).
//
// Por omissão corre em modo DRY-RUN (só mostra o que faria). Só escreve na
// base com --apply. Faz upsert por `id`, na ordem do manifesto (pais antes
// de filhos), em lotes — idempotente, pode voltar a correr sem duplicar.
//
//   node scripts/restore-backup.mjs backups/2026-07-16 --project-ref <ref> --company-id <uuid>
//   … --apply                      escreve mesmo
//   … --apply --tables=contracts,services
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).

import fs from "node:fs";
import path from "node:path";
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "restore-backup.mjs",
  purpose: "restaurar tabelas a partir de uma pasta de backup (upsert por id)",
  writes: true,
});

const dir = db.rest.find((a) => !a.startsWith("--"));
const tablesArg = db.rest.find((a) => a.startsWith("--tables="));
const onlyTables = tablesArg ? tablesArg.slice("--tables=".length).split(",").map((t) => t.trim()) : null;

if (!dir) {
  console.error("Uso: node scripts/restore-backup.mjs <pasta-backup> --project-ref <ref> --company-id <uuid> [--apply] [--tables=a,b,c]");
  process.exit(1);
}

const manifestPath = path.join(dir, "_MANIFEST.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Não encontrei ${manifestPath}. Esta pasta é de um backup gerado por scripts/backup-all.mjs?`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const tableNames = Object.keys(manifest.tables).filter((t) => !onlyTables || onlyTables.includes(t));

if (tableNames.length === 0) {
  console.error("Nenhuma tabela para restaurar (verifica --tables).");
  process.exit(1);
}

console.log(`Backup: ${dir} (gerado a partir de ${manifest.url ?? "?"})`);
console.log(`Tabelas: ${tableNames.join(", ")}\n`);

const BATCH = 200;

for (const table of tableNames) {
  const file = path.join(dir, `${table}.json`);
  if (!fs.existsSync(file)) {
    console.log(`⚠️  ${table}: ficheiro ${file} não existe, salto.`);
    continue;
  }
  const todos = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(todos) || todos.length === 0) {
    console.log(`—  ${table}: 0 registos no backup.`);
    continue;
  }

  // Um backup pode conter várias empresas. Restaurar com a chave
  // administrativa contorna o RLS, por isso o filtro por empresa tem de ser
  // feito aqui — senão `--company-id` era só uma flag para satisfazer o guard.
  const temCompanyId = Object.hasOwn(todos[0], "company_id");
  const rows = temCompanyId ? todos.filter((r) => r.company_id === db.companyId) : todos;
  const ignorados = todos.length - rows.length;

  if (!temCompanyId) {
    console.log(`   ${table}: sem coluna company_id — restaurado na íntegra (${rows.length}).`);
  } else if (ignorados) {
    console.log(`   ${table}: ${ignorados} registo(s) de outras empresas ignorados.`);
  }
  if (rows.length === 0) { console.log(`—  ${table}: nada desta empresa.`); continue; }

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.write(
      table,
      (t) => t.upsert(chunk, { onConflict: "id" }).select("id"),
      `${table} lote ${i}–${i + chunk.length - 1} (${chunk.length})`,
    );
  }
}

db.summary();
