// ============================================================================
// 🔴 ARQUIVADO — NÃO EXECUTAR (T17-B2, 2026-08-10)
// ============================================================================
//
// Preservado para AUDITORIA e para explicar como os dados actuais chegaram à
// base. NÃO é uma ferramenta operacional e não deve voltar a correr contra
// base nenhuma.
//
// Porquê:
//   apaga TODAS as linhas de services, contracts, daily_clocks, absences,
//   vacation_requests e management_tasks, sem filtro de company_id — portanto
//   em todas as empresas. Por cascata leva timesheets, ou seja o registo de
//   ponto das colaboradoras. A protecção de backup aponta para um caminho fixo
//   de 2026-07-01. Era de uma fase em que a base era descartável; deixou de
//   ser.
//
// A recusa abaixo é deliberadamente SEM ESCAPATÓRIA: não há flag, variável de
// ambiente nem argumento que a contorne. Se algum dia for mesmo preciso o que
// este código faz, o caminho é lê-lo, perceber o que faz HOJE, e escrever de
// propósito uma ferramenta nova com as guardas da T17-B2 — não desbloquear
// esta.
//
// Ver docs/SCRIPTS-SAFETY-MATRIX.md e AGENTS.md (REGRA ZERO).
// ============================================================================

console.error(
  "\n🔴 reset-operacao.mjs está ARQUIVADO e não pode ser executado.\n",
);
console.error(
  "   Foi retirado da superfície operacional na T17-B2 por ser capaz de\n   destruir ou duplicar dados reais. Fica versionado apenas como registo\n   histórico e para auditoria.\n\n   Ver docs/SCRIPTS-SAFETY-MATRIX.md\n",
);
process.exit(1);

// ─── Código histórico a partir daqui. Preservado sem alterações. ───────────

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
