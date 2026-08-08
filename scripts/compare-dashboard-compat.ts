/**
 * Compara o dashboard financeiro ANTIGO com o read model canónico da T15.
 *
 * Responde: "que classes de divergência existem entre o que o dashboard mostra
 * hoje e o que o modelo canónico calcula, para os mesmos dados?"
 *
 * Uso:
 *   npx tsx scripts/compare-dashboard-compat.ts
 *   npx tsx scripts/compare-dashboard-compat.ts --vat 6
 *   npx tsx scripts/compare-dashboard-compat.ts --out tmp/t15-relatorio.json
 *   npx tsx scripts/compare-dashboard-compat.ts --input tmp/casos-t15.json
 *
 * Sem `--input`, usa a matriz determinística de `defaultDashboardMatrix()`.
 *
 * 🚨 Nunca liga ao Supabase. Nunca lê credenciais. Nunca escreve na base.
 *    `assertNoWriteFlags` recusa --apply/--execute/--write/--commit/--force.
 *
 * ⚠️ Os números vêm de fixtures inventadas. NÃO os transformar numa estimativa
 *    de impacto em produção: medir isso exigiria ler a base real.
 */

import {
  type DashboardCase,
  compareDashboardCases,
  defaultDashboardMatrix,
} from "../src/domain/dashboard/dashboard-compat";
import { assertNoWriteFlags, emit, fail, readArg, readJsonInput } from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const vatArg = readArg(argv, "vat");
const vatRatePct = vatArg == null ? 23 : Number(vatArg);
if (!Number.isFinite(vatRatePct) || vatRatePct < 0) {
  fail(`--vat inválido: ${vatArg}`);
}

function asInvoiceRows(value: unknown): [number, string, string][] {
  if (!Array.isArray(value)) return [];
  const out: [number, string, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    if (typeof entry[0] !== "number") continue;
    if (typeof entry[1] !== "string" || typeof entry[2] !== "string") continue;
    out.push([entry[0], entry[1], entry[2]]);
  }
  return out;
}

function asServiceRows(value: unknown): [string, number, string][] {
  if (!Array.isArray(value)) return [];
  const out: [string, number, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    if (typeof entry[0] !== "string" || typeof entry[1] !== "number") continue;
    if (typeof entry[2] !== "string") continue;
    out.push([entry[0], entry[1], entry[2]]);
  }
  return out;
}

function asNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

const inputPath = readArg(argv, "input");
let cases: DashboardCase[];

if (inputPath) {
  const raw = readJsonInput(inputPath) as Record<string, unknown>;
  const list = Array.isArray(raw.cases) ? raw.cases : [];
  if (list.length === 0) fail('a entrada precisa de "cases": [...]');
  cases = list.map((entry, index) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    return {
      label: typeof c.label === "string" ? c.label : `caso ${index}`,
      year: typeof c.year === "number" ? c.year : 2026,
      month: typeof c.month === "number" ? c.month : 3,
      vatRatePct: typeof c.vatRatePct === "number" ? c.vatRatePct : vatRatePct,
      invoices: asInvoiceRows(c.invoices),
      payrollEuros: typeof c.payrollEuros === "number" ? c.payrollEuros : 0,
      expensesEuros: typeof c.expensesEuros === "number" ? c.expensesEuros : 0,
      receivedEuros: typeof c.receivedEuros === "number" ? c.receivedEuros : 0,
      services: asServiceRows(c.services),
      priorMonthsRevenueEuros: asNumbers(c.priorMonthsRevenueEuros),
    };
  });
} else {
  cases = defaultDashboardMatrix(vatRatePct);
}

const report = compareDashboardCases(cases);
const s = report.summary;

const euros = (c: number) => `${(c / 100).toFixed(2)} €`;

console.error("");
console.error(`Taxa de IVA usada nas fixtures: ${vatRatePct}%`);
console.error(`Casos analisados: ${s.totalCases}`);
console.error(`  sem divergência: ${s.unchanged}`);
console.error(`  com divergência: ${s.changed}`);
console.error("");
console.error("Desvios acumulados (canónico − antigo):");
console.error(`  Receita/Faturado ... ${euros(s.totalRevenueDriftCents)}`);
console.error(`  Custos ............. ${euros(s.totalCostDriftCents)}`);
console.error(`  Margem ............. ${euros(s.totalMarginDriftCents)}`);
console.error(`  Projeção ........... ${euros(s.totalProjectionDriftCents)}`);
console.error("");
console.error(`Clientes escondidos pelo gráfico antigo: ${s.totalHiddenClients}`);
if (s.worstMarginDriftLabel) {
  console.error(`Pior caso de margem: ${s.worstMarginDriftLabel} → ${euros(s.worstMarginDriftCents)}`);
}
console.error("");
console.error("Razões:");
for (const [reason, count] of Object.entries(s.byReason)) {
  if (count > 0) console.error(`  ${reason.padEnd(32, ".")} ${count}`);
}
console.error("");
console.error(
  "MARGIN_INFLATED é a mais consequente: o cartão 'Margem Bruta' subtrai apenas "
  + "a folha de pagamento a um valor faturado que já inclui IVA. O imposto entra "
  + "como se fosse receita da empresa, e as despesas de cash_flow_entries não "
  + "entram de todo nos custos — a margem sai inflacionada dos dois lados.",
);
console.error("");
console.error(
  "PROJECTION_MISMATCHED_BASIS: a projecção divide o total do ano (que inclui o "
  + "mês corrente, incompleto) pelo número de meses ANTERIORES com receita > 0. "
  + "Numerador e denominador falam de conjuntos diferentes.",
);
console.error("");
console.error(
  "⚠️ Fixtures sintéticas. Não converter estes números numa estimativa de "
  + "impacto real — isso exigiria ler produção, que esta ferramenta não faz.",
);
console.error("");

emit(report, readArg(argv, "out"));
