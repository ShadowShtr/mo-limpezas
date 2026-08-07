/**
 * Compara o algoritmo de recorrência ANTERIOR à T07 com o motor canónico.
 *
 * Responde à pergunta que bloqueia o merge do PR #46:
 * "quantos contratos existentes mudariam de datas, e quais?"
 *
 * Uso:
 *   npx tsx scripts/compare-recurrence-compat.ts --input contratos.json
 *   npx tsx scripts/compare-recurrence-compat.ts --input c.json --out relatorio.json
 *
 * Entrada esperada (só campos técnicos; tudo o resto é ignorado):
 *
 *   {
 *     "window": { "start": "2026-08-01", "end": "2027-07-31" },
 *     "contracts": [
 *       { "id": "…", "frequency": "biweekly", "weekdays": [1],
 *         "interval_days": 1, "starts_on": "2026-01-05",
 *         "ends_on": null, "excluded_dates": [] }
 *     ]
 *   }
 *
 * Nunca liga ao Supabase. Nunca lê credenciais. Nunca altera a entrada.
 */

import { compareContracts, type CompatContract } from "../src/domain/scheduling/recurrence-compat";
import {
  assertNoWriteFlags, emit, fail, pickContract, readArg, readJsonInput, str,
} from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const raw = readJsonInput(readArg(argv, "input")) as Record<string, unknown>;
const windowRaw = (raw.window ?? {}) as Record<string, unknown>;
const window = { start: str(windowRaw.start), end: str(windowRaw.end) };
if (!window.start || !window.end) {
  fail('a entrada precisa de "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }');
}

const rawContracts = Array.isArray(raw.contracts) ? raw.contracts : [];
if (rawContracts.length === 0) fail('a entrada precisa de "contracts": [...]');

const contracts: CompatContract[] = rawContracts.map((c) => {
  const picked = pickContract(c);
  return {
    id: picked.id,
    frequency: picked.frequency,
    weekdays: picked.weekdays,
    intervalDays: picked.intervalDays,
    startsOn: picked.startsOn,
    endsOn: picked.endsOn,
    excludedDates: picked.excludedDates,
  };
});

const report = compareContracts(contracts, window);
const s = report.summary;

console.error("");
console.error(`Janela: ${window.start} → ${window.end}`);
console.error(`Contratos analisados: ${s.totalContracts}`);
console.error(`  sem alteração: ${s.unchanged}`);
console.error(`  com alteração: ${s.changed}`);
console.error("");
console.error("Alterados por frequência:");
console.error(`  diário .............. ${s.dailyChanged}`);
console.error(`  semanal ............. ${s.weeklyChanged}`);
console.error(`  quinzenal ........... ${s.biweeklyChanged}`);
console.error(`  3 em 3 semanas ...... ${s.triweeklyChanged}`);
console.error(`  mensal .............. ${s.monthlyChanged}`);
console.error(`  personalizado ....... ${s.customChanged}`);
console.error(`  outra ............... ${s.otherChanged}`);
console.error("");
console.error("Razões:");
for (const [reason, count] of Object.entries(s.byReason)) {
  if (count > 0) console.error(`  ${reason.padEnd(22, ".")} ${count}`);
}
console.error("");
console.error(`Datas acrescentadas: ${s.datesAdded}`);
console.error(`Datas removidas: ${s.datesRemoved}`);
if (s.invalidRules > 0) console.error(`Regras inválidas (não geram nada): ${s.invalidRules}`);
console.error("");
if (s.weeklyChanged > 0 || s.dailyChanged > 0 || s.customChanged > 0) {
  console.error(
    "⚠ Diário, semanal e personalizado NÃO deviam mudar. Verificar caso a caso "
    + "antes de aceitar o resultado.",
  );
}

emit(report, readArg(argv, "out"));
