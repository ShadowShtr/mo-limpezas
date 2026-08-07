/**
 * Compara as fórmulas financeiras ANTIGAS com o modelo canónico da T11.
 *
 * Responde: "quanto dinheiro difere entre a Cobrança Diária, os Relatórios, o
 * Dashboard e a Fatura, para a mesma avença?"
 *
 * Uso:
 *   npx tsx scripts/compare-billing-compat.ts
 *   npx tsx scripts/compare-billing-compat.ts --vat 6
 *   npx tsx scripts/compare-billing-compat.ts --out tmp/t11-relatorio.json
 *   npx tsx scripts/compare-billing-compat.ts --input tmp/casos.json
 *
 * Entrada opcional (só fixtures SINTÉTICAS; nunca dados reais):
 *
 *   { "cases": [
 *       { "label": "…", "fixedPriceEuros": 100, "occurrenceCount": 3,
 *         "applyVat": true, "vatRatePct": 23 }
 *   ] }
 *
 * Sem `--input`, usa a matriz determinística de `defaultAvencaMatrix()`.
 *
 * Nunca liga ao Supabase. Nunca lê credenciais. Nunca escreve na base.
 */

import {
  type AvencaCase,
  compareAvencaCases,
  defaultAvencaMatrix,
  driftToEuros,
} from "../src/domain/billing/billing-compat";
import { assertNoWriteFlags, emit, fail, readArg, readJsonInput } from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const vatArg = readArg(argv, "vat");
const vatRatePct = vatArg == null ? 23 : Number(vatArg);
if (!Number.isFinite(vatRatePct) || vatRatePct < 0) {
  fail(`--vat inválido: ${vatArg}`);
}

const inputPath = readArg(argv, "input");
let cases: AvencaCase[];

if (inputPath) {
  const raw = readJsonInput(inputPath) as Record<string, unknown>;
  const list = Array.isArray(raw.cases) ? raw.cases : [];
  if (list.length === 0) fail('a entrada precisa de "cases": [...]');
  cases = list.map((entry, index) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const price = c.fixedPriceEuros;
    return {
      label: typeof c.label === "string" ? c.label : `caso ${index}`,
      fixedPriceEuros: typeof price === "number" ? price : null,
      occurrenceCount: typeof c.occurrenceCount === "number" ? c.occurrenceCount : 0,
      applyVat: c.applyVat === true,
      vatRatePct: typeof c.vatRatePct === "number" ? c.vatRatePct : vatRatePct,
    };
  });
} else {
  cases = defaultAvencaMatrix(vatRatePct);
}

const report = compareAvencaCases(cases);
const s = report.summary;

const euros = (cents: number) => `${driftToEuros(cents).toFixed(2)} €`;

console.error("");
console.error(`Taxa de IVA usada nas fixtures: ${vatRatePct}%`);
console.error(`Casos analisados: ${s.totalCases}`);
console.error(`  sem divergência: ${s.unchanged}`);
console.error(`  com divergência: ${s.changed}`);
console.error("");
console.error("Desvio acumulado face ao canónico:");
console.error(`  Cobrança Diária .... ${euros(s.totalDailyDriftCents)} (${s.totalDailyDriftCents} cêntimos)`);
console.error(`  Relatórios ......... ${euros(s.totalReportsDriftCents)} (${s.totalReportsDriftCents} cêntimos)`);
console.error(`  Dashboard (c/ IVA) . ${euros(s.totalDashboardDriftCents)} (${s.totalDashboardDriftCents} cêntimos)`);
console.error("");
console.error("Razões:");
for (const [reason, count] of Object.entries(s.byReason)) {
  if (count > 0) console.error(`  ${reason.padEnd(26, ".")} ${count}`);
}
console.error("");
if (s.worstDriftLabel) {
  console.error(`Pior caso isolado: ${s.worstDriftLabel} → ${euros(s.worstDriftCents)}`);
}
console.error("");
console.error(
  "A fatura NÃO aparece nos desvios acima porque não divide a avença: emite uma "
  + "linha mensal inteira. Ver invoiceDriftCents no relatório para o caso a caso.",
);
console.error("");

emit(report, readArg(argv, "out"));
