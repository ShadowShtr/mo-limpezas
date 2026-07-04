// RESET da operação: apaga serviços, contratos e registos de trabalho.
// MANTÉM: empresa, utilizadores/colaboradores, equipas, clientes, locais,
//         e TODO o financeiro (banco, cash flow, faturas, salários).
// cash_flow_entries e notificações mantêm-se — só perdem a ligação ao serviço.
//
//   node scripts/reset-operacao.mjs          → dry-run (só conta)
//   node scripts/reset-operacao.mjs --apply  → APAGA a sério
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
const APPLY = process.argv.includes("--apply");
const ZERO = "00000000-0000-0000-0000-000000000000";

// Segurança: exige backup no disco antes de apagar.
const BK = "backups/2026-07-01_pre-reset/_MANIFEST.json";
if (APPLY && !fs.existsSync(BK)) {
  console.error(`❌ Backup não encontrado em ${BK}. Aborta.`);
  process.exit(1);
}

// Ordem importa: services primeiro (cascata trata dos filhos), depois o resto.
const TARGETS = [
  "services",          // cascata → timesheets, service_reinforcements, service_price_audit, service_photos
  "contracts",
  "daily_clocks",
  "absences",
  "vacation_requests",
  "management_tasks",
];

async function count(t) {
  const { count } = await sb.from(t).select("id", { count: "exact", head: true });
  return count ?? 0;
}

for (const t of TARGETS) {
  const before = await count(t);
  if (!APPLY) {
    console.log(`• ${t}: ${before} registos serão apagados`);
    continue;
  }
  const { error } = await sb.from(t).delete().neq("id", ZERO);
  if (error) {
    console.error(`❌ ${t}: ${error.message}`);
    continue;
  }
  const after = await count(t);
  console.log(`🗑️  ${t}: ${before} → ${after}`);
}
console.log(`\n${APPLY ? "✅ RESET APLICADO" : "DRY-RUN (nada apagado). Corre com --apply para executar."}`);
