// Restaura serviços a partir de HOJE (scheduled_start >= today) a partir do backup.
//   node scripts/restore-servicos.mjs
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

const TODAY = process.argv[2] || "2026-07-01";
const all = JSON.parse(fs.readFileSync("backups/2026-07-01_pre-reset/services.json", "utf8"));
const rows = all.filter((s) => s.scheduled_start && s.scheduled_start.slice(0, 10) >= TODAY);
console.log(`A restaurar ${rows.length} serviços (a partir de ${TODAY})...`);

let ok = 0;
const BATCH = 200;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { data, error } = await sb.from("services").upsert(chunk, { onConflict: "id" }).select("id");
  if (error) { console.error(`❌ lote ${i}: ${error.message}`); continue; }
  ok += data.length;
}
const { count } = await sb.from("services").select("id", { count: "exact", head: true });
console.log(`✅ Restaurados ${ok}. Total de serviços na base agora: ${count}`);
