// Restaura serviços a partir de um backup, a partir de uma data (inclusive).
//
//   node scripts/restore-servicos.mjs <pasta-backup> --from 2026-07-01 \
//     --project-ref <ref> --company-id <uuid>
//   … --apply   para escrever mesmo.
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import fs from "node:fs";
import path from "node:path";
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "restore-servicos.mjs",
  purpose: "restaurar serviços de um backup a partir de uma data (upsert por id)",
  writes: true,
});

// Pasta e data deixaram de estar fixas no código. A versão anterior tinha
// `backups/2026-07-01_pre-reset/` e a data `2026-07-01` gravadas, e a data
// vinha de `process.argv[2]` — que agora pode ser uma flag, o que faria o
// script restaurar silenciosamente a partir do dia errado.
const pasta = db.rest[0];
const desde = db.rest[1] ?? null;

if (!pasta || !desde) {
  console.error(
    "Uso: node scripts/restore-servicos.mjs <pasta-backup> <YYYY-MM-DD> --project-ref <ref> --company-id <uuid> [--apply]",
  );
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error(`Data inválida: "${desde}". Formato esperado: YYYY-MM-DD.`);
  process.exit(1);
}

const ficheiro = path.join(pasta, "services.json");
if (!fs.existsSync(ficheiro)) {
  console.error(`Não encontrei ${ficheiro}.`);
  process.exit(1);
}

const todos = JSON.parse(fs.readFileSync(ficheiro, "utf8"));

// Dois filtros, não um: a data pedida e a empresa declarada. Sem o segundo, um
// backup com várias empresas restaurava linhas de outros tenants — a chave
// administrativa contorna o RLS e ninguém travava.
const daEmpresa = todos.filter((s) => s.company_id === db.companyId);
const rows = daEmpresa.filter((s) => s.scheduled_start && s.scheduled_start.slice(0, 10) >= desde);
const ignorados = todos.length - daEmpresa.length;

console.log(`Backup: ${pasta} | a partir de ${desde}`);
console.log(`Serviços no ficheiro: ${todos.length} | desta empresa: ${daEmpresa.length} | a restaurar: ${rows.length}`
  + (ignorados ? ` | de outras empresas, ignorados: ${ignorados}` : ""));

if (rows.length === 0) {
  console.error("Nada a restaurar com estes critérios.");
  process.exit(1);
}

const BATCH = 200;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  await db.write(
    "services",
    (t) => t.upsert(chunk, { onConflict: "id" }).select("id"),
    `lote ${i}–${i + chunk.length - 1} (${chunk.length} serviços)`,
  );
}

const { count, error } = await db.sb.from("services")
  .select("id", { count: "exact", head: true })
  .eq("company_id", db.companyId);
if (error) console.error(`contagem final indisponível: ${error.message}`);
else console.log(`Total de serviços desta empresa na base: ${count}`);

db.summary();
