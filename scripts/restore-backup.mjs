// Restauro genérico a partir de um backup gerado por backup-all.mjs
// (pasta backups/<stamp>/ com _MANIFEST.json + <tabela>.json por tabela).
//
// Por omissão corre em modo DRY-RUN (só mostra o que faria). Só escreve na
// base com --apply. Faz upsert por `id`, na ordem do manifesto (pais antes
// de filhos), em lotes — idempotente, pode voltar a correr sem duplicar.
//
//   node scripts/restore-backup.mjs backups/2026-07-16
//   node scripts/restore-backup.mjs backups/2026-07-16 --apply
//   node scripts/restore-backup.mjs backups/2026-07-16 --apply --tables=contracts,services

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

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const APPLY = args.includes("--apply");
const tablesArg = args.find((a) => a.startsWith("--tables="));
const onlyTables = tablesArg ? tablesArg.slice("--tables=".length).split(",").map((t) => t.trim()) : null;

if (!dir) {
  console.error("Uso: node scripts/restore-backup.mjs <pasta-backup> [--apply] [--tables=a,b,c]");
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
console.log(`Modo: ${APPLY ? "APLICAR (vai escrever na base)" : "DRY-RUN (nada é escrito — usa --apply para aplicar)"}`);
console.log(`Tabelas: ${tableNames.join(", ")}\n`);

const BATCH = 200;
let totalOk = 0;
let totalErr = 0;

for (const table of tableNames) {
  const file = path.join(dir, `${table}.json`);
  if (!fs.existsSync(file)) {
    console.log(`⚠️  ${table}: ficheiro ${file} não existe, salto.`);
    continue;
  }
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`—  ${table}: 0 registos no backup.`);
    continue;
  }

  if (!APPLY) {
    console.log(`   ${table}: ${rows.length} registos seriam restaurados (upsert por id).`);
    continue;
  }

  let ok = 0;
  let err = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { data, error } = await sb.from(table).upsert(chunk, { onConflict: "id" }).select("id");
    if (error) {
      err += chunk.length;
      console.error(`   ❌ ${table} lote ${i}: ${error.message}`);
      continue;
    }
    ok += data.length;
  }
  totalOk += ok;
  totalErr += err;
  console.log(`✅ ${table}: ${ok}/${rows.length} restaurados${err ? ` (${err} falharam)` : ""}.`);
}

if (APPLY) {
  console.log(`\nTotal: ${totalOk} restaurados, ${totalErr} falhas.`);
} else {
  console.log("\nDry-run concluído — nada foi escrito. Confirma os números e corre de novo com --apply.");
}
