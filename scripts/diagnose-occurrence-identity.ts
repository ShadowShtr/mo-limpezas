/**
 * Diagnostica a identidade das ocorrências num snapshot exportado.
 *
 * SÓ RELATÓRIO. Não altera a entrada, não escreve na base, não liga a nada.
 *
 * Uso:
 *   npx tsx scripts/diagnose-occurrence-identity.ts --input snapshot.json
 *   npx tsx scripts/diagnose-occurrence-identity.ts --input s.json --out diagnostico.json
 *
 * Entrada esperada (só campos técnicos; tudo o resto é ignorado):
 *
 *   {
 *     "window": { "start": "2026-01-01", "end": "2026-12-31" },
 *     "contracts": [ { "id", "company_id", "status", "frequency", "weekdays",
 *                      "interval_days", "starts_on", "ends_on", "excluded_dates" } ],
 *     "services":  [ { "id", "company_id", "contract_id", "occurrence_date",
 *                      "scheduled_start" | "scheduled_date", "status",
 *                      "is_exception", "original_date", "created_at" } ]
 *   }
 */

import { diagnose, validateSnapshot, type ContractRecord, type RepairSnapshot } from "../src/domain/scheduling/occurrence-repair";
import type { ServiceRecord, ServiceStatus } from "../src/domain/scheduling/occurrence-identity";
import {
  assertNoWriteFlags, emit, fail, pickContract, pickService, readArg, readJsonInput, str,
} from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const raw = readJsonInput(readArg(argv, "input")) as Record<string, unknown>;
const windowRaw = (raw.window ?? {}) as Record<string, unknown>;
const window = { start: str(windowRaw.start), end: str(windowRaw.end) };

const contracts: ContractRecord[] = (Array.isArray(raw.contracts) ? raw.contracts : []).map((c) => {
  const p = pickContract(c);
  return {
    id: p.id,
    companyId: p.companyId,
    status: p.status,
    frequency: p.frequency,
    weekdays: p.weekdays,
    intervalDays: p.intervalDays,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    excludedDates: p.excludedDates,
  };
});

const services: ServiceRecord[] = (Array.isArray(raw.services) ? raw.services : []).map((s) => {
  const p = pickService(s);
  return { ...p, status: p.status as ServiceStatus };
});

const snapshot: RepairSnapshot = { window, contracts, services };

const problems = validateSnapshot(snapshot);
if (problems.length > 0) {
  console.error("❌ snapshot inválido:");
  for (const p of problems.slice(0, 20)) console.error(`   - ${p}`);
  if (problems.length > 20) console.error(`   … e mais ${problems.length - 20}`);
  fail("corrija a exportação antes de continuar");
}

const report = diagnose(snapshot);
const s = report.summary;

console.error("");
console.error(`Janela: ${window.start} → ${window.end}`);
console.error(`Contratos: ${s.contracts} · Serviços: ${s.services}`);
console.error("");
console.error("Classificação dos serviços:");
for (const [name, count] of Object.entries(s.byClass)) {
  if (count > 0) console.error(`  ${name.padEnd(22, ".")} ${count}`);
}
console.error("");
console.error(`Grupos de duplicados ................ ${s.duplicateGroups}`);
console.error(`Serviços envolvidos em duplicados ... ${s.duplicateServices}`);
console.error(`Ocorrências canónicas sem serviço ... ${s.missingOccurrences}`);
console.error(`Serviços em datas excluídas ......... ${s.excludedButPresent}`);
console.error(`Serviços sem contrato ............... ${s.servicesWithoutContract}`);
console.error(`Serviços com contrato inexistente ... ${s.servicesWithUnknownContract}`);
console.error(`Exigem revisão humana ............... ${s.needsManualReview}`);
console.error("");

if (s.originalDatePresent > 0) {
  console.error(
    `⚠ ${s.originalDatePresent} serviços têm original_date preenchida. Nenhum código `
    + "do projeto escreve essa coluna — a origem é desconhecida e o backfill NÃO a usa.",
  );
  console.error("");
}

emit(report, readArg(argv, "out"));
