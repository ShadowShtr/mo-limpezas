// Restaura os contratos a partir do backup (mantém IDs originais).
//   node scripts/restore-contratos.mjs
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = fs.readFileSync(".env.local", "utf8").split("\n").reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2].replace(/^"|"$/g, "");
  return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const rows = JSON.parse(fs.readFileSync("backups/2026-07-01_pre-reset/contracts.json", "utf8"));
console.log(`A restaurar ${rows.length} contratos...`);

let ok = 0;
const BATCH = 100;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { data, error } = await sb.from("contracts").upsert(chunk, { onConflict: "id" }).select("id");
  if (error) { console.error(`❌ lote ${i}: ${error.message}`); continue; }
  ok += data.length;
}
const { count } = await sb.from("contracts").select("id", { count: "exact", head: true });
console.log(`✅ Restaurados ${ok}. Total na base agora: ${count}`);
