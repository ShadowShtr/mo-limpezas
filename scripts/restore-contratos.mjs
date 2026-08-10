// Restaura contratos a partir de um backup, mantendo os IDs originais.
//
//   node scripts/restore-contratos.mjs <pasta-backup> --project-ref <ref> --company-id <uuid>
//   node scripts/restore-contratos.mjs <pasta-backup> --project-ref <ref> --company-id <uuid> --apply
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import fs from "node:fs";
import path from "node:path";
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "restore-contratos.mjs",
  purpose: "restaurar contratos de um backup (upsert por id)",
  writes: true,
});

// A pasta do backup passou a ser um argumento. Antes estava fixa em
// `backups/2026-07-01_pre-reset/` — um script de restauro amarrado a uma data
// concreta restaura sempre o mesmo estado antigo, independentemente do que se
// pretendia repor.
const pasta = db.rest[0];
if (!pasta) {
  console.error("Indica a pasta do backup: node scripts/restore-contratos.mjs <pasta-backup> …");
  process.exit(1);
}

const ficheiro = path.join(pasta, "contracts.json");
if (!fs.existsSync(ficheiro)) {
  console.error(`Não encontrei ${ficheiro}.`);
  process.exit(1);
}

const todos = JSON.parse(fs.readFileSync(ficheiro, "utf8"));

// O backup pode conter mais do que uma empresa. Restaurar linhas de outra
// empresa com a chave administrativa contornaria o RLS e misturaria dados de
// tenants — filtrar aqui é o que torna `--company-id` real e não decorativo.
const rows = todos.filter((r) => r.company_id === db.companyId);
const ignorados = todos.length - rows.length;

console.log(`Backup: ${pasta}`);
console.log(`Contratos no ficheiro: ${todos.length} | desta empresa: ${rows.length}`
  + (ignorados ? ` | de outras empresas, ignorados: ${ignorados}` : ""));

if (rows.length === 0) {
  console.error("Nada a restaurar para esta empresa.");
  process.exit(1);
}

const BATCH = 100;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  await db.write(
    "contracts",
    (t) => t.upsert(chunk, { onConflict: "id" }).select("id"),
    `lote ${i}–${i + chunk.length - 1} (${chunk.length} contratos)`,
  );
}

const { count, error } = await db.sb.from("contracts")
  .select("id", { count: "exact", head: true })
  .eq("company_id", db.companyId);
if (error) console.error(`contagem final indisponível: ${error.message}`);
else console.log(`Total de contratos desta empresa na base: ${count}`);

db.summary();
