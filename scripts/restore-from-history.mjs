// ============================================================================
// RESTAURO A PARTIR DO HISTÓRICO (data_history — migração 059)
// ============================================================================
// A rede de segurança guarda o estado anterior de todo UPDATE/DELETE nas
// tabelas críticas. Este script permite VER esse histórico e RESTAURAR
// qualquer versão anterior de qualquer registo.
//
// Uso:
//   node scripts/restore-from-history.mjs --table services --id <uuid>
//       → lista o histórico desse registo (o que mudou, quando, por quem)
//
//   node scripts/restore-from-history.mjs --show <history_id>
//       → mostra o antes/depois completo de uma entrada do histórico
//
//   node scripts/restore-from-history.mjs --restore <history_id>
//       → repõe o estado ANTERIOR (old_data) dessa entrada:
//         - se foi UPDATE: faz UPDATE com os valores antigos;
//         - se foi DELETE: reinsere a linha apagada.
//         O próprio restauro fica registado no histórico (é reversível).
//
//   node scripts/restore-from-history.mjs --recent [N]
//       → últimas N alterações em todas as tabelas (default 30)
//
// Precisa de SUPABASE_DB_URL no .env.local (o mesmo do run-migrations).
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
  console.error("❌ Define SUPABASE_DB_URL no .env.local (ver FASE 0 do documento CORREÇÃO E AUDITORIA V).");
  process.exit(1);
}

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : null;
};

const ALLOWED_TABLES = new Set(["clients", "locations", "contracts", "services", "invoices", "invoice_items"]);

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

function summarizeDiff(oldData, newData) {
  if (!newData) return "(linha apagada — DELETE)";
  const changed = [];
  for (const k of Object.keys(newData)) {
    if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) {
      changed.push(`${k}: ${JSON.stringify(oldData[k])} → ${JSON.stringify(newData[k])}`);
    }
  }
  return changed.join(" | ") || "(sem diferenças visíveis)";
}

async function listRow(table, rowId) {
  if (!ALLOWED_TABLES.has(table)) { console.error(`❌ Tabela inválida. Permitidas: ${[...ALLOWED_TABLES].join(", ")}`); process.exit(1); }
  const { rows } = await client.query(
    `SELECT id, op, changed_at, actor, old_data, new_data
     FROM public.data_history
     WHERE table_name = $1 AND row_id = $2
     ORDER BY changed_at DESC LIMIT 100`,
    [table, rowId],
  );
  if (rows.length === 0) { console.log("Sem histórico para este registo (a rede de segurança só capta alterações feitas depois da migração 059)."); return; }
  console.log(`Histórico de ${table}/${rowId} — ${rows.length} entrada(s), mais recente primeiro:\n`);
  for (const r of rows) {
    console.log(`#${r.id}  ${r.op}  ${r.changed_at.toISOString()}  actor=${r.actor ?? "sistema/service-role"}`);
    console.log(`   ${summarizeDiff(r.old_data, r.new_data)}\n`);
  }
  console.log(`Para ver uma entrada completa:  node scripts/restore-from-history.mjs --show <numero>`);
  console.log(`Para repor o estado ANTERIOR:   node scripts/restore-from-history.mjs --restore <numero>`);
}

async function showEntry(historyId) {
  const { rows } = await client.query("SELECT * FROM public.data_history WHERE id = $1", [historyId]);
  if (rows.length === 0) { console.error("❌ Entrada não encontrada."); process.exit(1); }
  const r = rows[0];
  console.log(`Entrada #${r.id} — ${r.op} em ${r.table_name}/${r.row_id} @ ${r.changed_at.toISOString()}\n`);
  console.log("ANTES (old_data):\n" + JSON.stringify(r.old_data, null, 2));
  if (r.new_data) console.log("\nDEPOIS (new_data):\n" + JSON.stringify(r.new_data, null, 2));
}

async function restoreEntry(historyId) {
  const { rows } = await client.query("SELECT * FROM public.data_history WHERE id = $1", [historyId]);
  if (rows.length === 0) { console.error("❌ Entrada não encontrada."); process.exit(1); }
  const r = rows[0];
  if (!ALLOWED_TABLES.has(r.table_name)) { console.error("❌ Tabela fora da lista permitida."); process.exit(1); }

  // Colunas reais da tabela (o old_data pode ter colunas que entretanto
  // deixaram de existir — restauramos só as que existem).
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [r.table_name],
  );
  const existing = new Set(cols.map((c) => c.column_name));
  const restorable = Object.keys(r.old_data).filter((k) => existing.has(k) && k !== "id");

  console.log(`A restaurar entrada #${r.id} (${r.op}) em ${r.table_name}/${r.row_id}...`);
  await client.query("BEGIN");
  try {
    // Restauros são operações conscientes: desliga a guarda do hourly_rate
    // apenas dentro desta transação.
    await client.query("SET LOCAL app.allow_unsafe = 'on'");

    if (r.op === "DELETE") {
      const colList = ["id", ...restorable].map((c) => `"${c}"`).join(", ");
      await client.query(
        `INSERT INTO public."${r.table_name}" (${colList})
         SELECT ${colList} FROM jsonb_populate_record(NULL::public."${r.table_name}", $1::jsonb)`,
        [JSON.stringify(r.old_data)],
      );
      console.log("✅ Linha apagada foi REINSERIDA com o estado anterior.");
    } else {
      const setList = restorable.map((c) => `"${c}" = rec."${c}"`).join(", ");
      const res = await client.query(
        `UPDATE public."${r.table_name}" t
         SET ${setList}
         FROM jsonb_populate_record(NULL::public."${r.table_name}", $1::jsonb) rec
         WHERE t.id = $2`,
        [JSON.stringify(r.old_data), r.row_id],
      );
      if (res.rowCount === 0) throw new Error("0 linhas afetadas — a linha já não existe (usa a entrada DELETE dela para reinserir).");
      console.log(`✅ Registo reposto ao estado de ${new Date(r.changed_at).toISOString()} (${res.rowCount} linha).`);
    }
    await client.query("COMMIT");
    console.log("O próprio restauro ficou registado no histórico — também é reversível.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`❌ Restauro falhou e foi revertido: ${err.message}`);
    process.exit(1);
  }
}

async function recent(n) {
  const { rows } = await client.query(
    `SELECT id, table_name, row_id, op, changed_at, actor, old_data, new_data
     FROM public.data_history ORDER BY changed_at DESC LIMIT $1`,
    [n],
  );
  if (rows.length === 0) { console.log("Histórico vazio (a migração 059 já foi aplicada?)."); return; }
  console.log(`Últimas ${rows.length} alterações captadas pela rede de segurança:\n`);
  for (const r of rows) {
    console.log(`#${r.id}  ${r.changed_at.toISOString()}  ${r.op.padEnd(6)} ${r.table_name}/${String(r.row_id).slice(0, 8)}  actor=${r.actor ? String(r.actor).slice(0, 8) : "sistema"}`);
    console.log(`   ${summarizeDiff(r.old_data, r.new_data).slice(0, 160)}\n`);
  }
}

async function main() {
  await client.connect();
  try {
    const table = getFlag("table");
    const id = getFlag("id");
    const show = getFlag("show");
    const restore = getFlag("restore");
    const recentFlagIdx = args.indexOf("--recent");

    if (show) await showEntry(Number(show));
    else if (restore) await restoreEntry(Number(restore));
    else if (table && id) await listRow(table, id);
    else if (recentFlagIdx >= 0) await recent(Number(args[recentFlagIdx + 1]) || 30);
    else {
      console.log("Uso:");
      console.log("  --table <tabela> --id <uuid>   histórico de um registo");
      console.log("  --show <history_id>            ver antes/depois completo");
      console.log("  --restore <history_id>         repor o estado anterior");
      console.log("  --recent [N]                   últimas N alterações (default 30)");
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Erro fatal:", e.message); process.exit(2); });
