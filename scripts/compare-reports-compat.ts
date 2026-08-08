/**
 * Compara as agregações de relatório ANTIGAS com o read model canónico da T14.
 *
 * Responde: "que classes de divergência existem entre o que os Relatórios
 * mostram hoje e o que o modelo canónico calcula, para os mesmos dados?"
 *
 * Uso:
 *   npx tsx scripts/compare-reports-compat.ts
 *   npx tsx scripts/compare-reports-compat.ts --vat 6
 *   npx tsx scripts/compare-reports-compat.ts --out tmp/t14-relatorio.json
 *   npx tsx scripts/compare-reports-compat.ts --input tmp/casos-t14.json
 *
 * Entrada opcional (só fixtures SINTÉTICAS; nunca dados reais):
 *
 *   { "cases": [
 *       { "label": "…", "year": 2026, "month": 8, "vatRatePct": 23,
 *         "monthlyPriceEuros": 100, "applyVat": true,
 *         "avencaStatuses": ["concluido", "concluido"],
 *         "adhoc": [["concluido", 50]],
 *         "absences": [["2026-07-20", "2026-08-05"]] }
 *   ] }
 *
 * Sem `--input`, usa a matriz determinística de `defaultReportMatrix()`.
 *
 * 🚨 Nunca liga ao Supabase. Nunca lê credenciais. Nunca escreve na base.
 *    `assertNoWriteFlags` recusa --apply/--execute/--write/--commit/--force.
 *
 * ⚠️ Os números que este comparador produz vêm de fixtures inventadas. NÃO os
 *    transformar numa estimativa de impacto em produção: medir isso exigiria
 *    ler a base real, o que esta task não faz.
 */

import {
  type ReportCase,
  compareReportCases,
  defaultReportMatrix,
} from "../src/domain/reports/reports-compat";
import { assertNoWriteFlags, emit, fail, readArg, readJsonInput } from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const vatArg = readArg(argv, "vat");
const vatRatePct = vatArg == null ? 23 : Number(vatArg);
if (!Number.isFinite(vatRatePct) || vatRatePct < 0) {
  fail(`--vat inválido: ${vatArg}`);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asPairArray(value: unknown): [string, number][] {
  if (!Array.isArray(value)) return [];
  const out: [string, number][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    if (typeof entry[0] !== "string" || typeof entry[1] !== "number") continue;
    out.push([entry[0], entry[1]]);
  }
  return out;
}

function asDatePairArray(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  const out: [string, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    if (typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
    out.push([entry[0], entry[1]]);
  }
  return out;
}

const inputPath = readArg(argv, "input");
let cases: ReportCase[];

if (inputPath) {
  const raw = readJsonInput(inputPath) as Record<string, unknown>;
  const list = Array.isArray(raw.cases) ? raw.cases : [];
  if (list.length === 0) fail('a entrada precisa de "cases": [...]');
  cases = list.map((entry, index) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    return {
      label: typeof c.label === "string" ? c.label : `caso ${index}`,
      year: typeof c.year === "number" ? c.year : 2026,
      month: typeof c.month === "number" ? c.month : 8,
      vatRatePct: typeof c.vatRatePct === "number" ? c.vatRatePct : vatRatePct,
      monthlyPriceEuros: typeof c.monthlyPriceEuros === "number" ? c.monthlyPriceEuros : null,
      applyVat: c.applyVat === true,
      avencaStatuses: asStringArray(c.avencaStatuses),
      adhoc: asPairArray(c.adhoc),
      absences: asDatePairArray(c.absences),
    };
  });
} else {
  cases = defaultReportMatrix(vatRatePct);
}

const report = compareReportCases(cases);
const s = report.summary;

const euros = (c: number) => `${(c / 100).toFixed(2)} €`;

console.error("");
console.error(`Taxa de IVA usada nas fixtures: ${vatRatePct}%`);
console.error(`Casos analisados: ${s.totalCases}`);
console.error(`  sem divergência: ${s.unchanged}`);
console.error(`  com divergência: ${s.changed}`);
console.error("");
console.error("Receita (realizado canónico − receita antiga):");
console.error(`  desvio acumulado ... ${euros(s.totalRevenueDriftCents)} (${s.totalRevenueDriftCents} cêntimos)`);
if (s.worstRevenueDriftLabel) {
  console.error(`  pior caso .......... ${s.worstRevenueDriftLabel} → ${euros(s.worstRevenueDriftCents)}`);
}
console.error("");
console.error("Absentismo (canónico − antigo, em dias):");
console.error(`  desvio acumulado ... ${s.totalAbsenceDriftDays} dias`);
console.error(`  casos com total impossível para o período: ${s.casesWithImpossibleAbsence}`);
console.error("");
console.error("Razões:");
for (const [reason, count] of Object.entries(s.byReason)) {
  if (count > 0) console.error(`  ${reason.padEnd(30, ".")} ${count}`);
}
console.error("");
console.error(
  "MONTHLY_INVISIBLE_IN_REVENUE é a mais grave: a receita antiga soma "
  + "services.calculated_value, e uma ocorrência de avença vale 0 por desenho. "
  + "O contrato mensal não aparece de todo no KPI 'Receita' dos Relatórios, "
  + "enquanto o separador 'Faturação diária' do MESMO ecrã o mostra dividido "
  + "pelos dias. Dois números, ambos rotulados como receita.",
);
console.error("");
console.error(
  "⚠️ Fixtures sintéticas. Não converter estes números numa estimativa de "
  + "impacto real — isso exigiria ler produção, que esta ferramenta não faz.",
);
console.error("");

emit(report, readArg(argv, "out"));
