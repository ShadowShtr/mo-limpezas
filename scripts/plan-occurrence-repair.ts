/**
 * Produz o PLANO de reparação da identidade de ocorrências.
 *
 * Separação deliberada, em três etapas que nunca se misturam:
 *
 *   diagnose-occurrence-identity.ts  → o que está mal   (factos)
 *   plan-occurrence-repair.ts        → o que fazer      (intenções)   ← aqui
 *   (execução)                       → fazer             (ainda não existe)
 *
 * Este script NÃO altera nada e não emite um único `DELETE` ou `UPDATE`.
 * Duplicados saem como candidatos, com veredicto de segurança
 * (SAFE_TO_MERGE / MANUAL_REVIEW). A execução real depende do schema da T08,
 * que ainda não foi aplicado, e da base descartável, que ainda não existe.
 *
 * Uso:
 *   npx tsx scripts/plan-occurrence-repair.ts --input snapshot.json
 *   npx tsx scripts/plan-occurrence-repair.ts --input s.json --out plano.json
 *
 * A entrada é a mesma do diagnóstico, e pode trazer opcionalmente as
 * dependências de cada serviço — sem elas, nenhum duplicado é considerado
 * seguro por omissão:
 *
 *   "dependencies": {
 *     "<service_id>": { "timesheets": 1, "invoiceItems": 0, "photos": 2,
 *                       "reinforcements": 0, "notifications": 0, "priceAudits": 0 }
 *   }
 */

import {
  diagnose, planRepair, validateSnapshot,
  type ContractRecord, type DependencySignals, type RepairSnapshot,
} from "../src/domain/scheduling/occurrence-repair";
import type { ServiceRecord, ServiceStatus } from "../src/domain/scheduling/occurrence-identity";
import {
  assertNoWriteFlags, emit, fail, num, pickContract, pickService, readArg, readJsonInput, str,
} from "./t08-io";

const argv = process.argv.slice(2);
assertNoWriteFlags(argv);

const raw = readJsonInput(readArg(argv, "input")) as Record<string, unknown>;
const windowRaw = (raw.window ?? {}) as Record<string, unknown>;
const window = { start: str(windowRaw.start), end: str(windowRaw.end) };

const contracts: ContractRecord[] = (Array.isArray(raw.contracts) ? raw.contracts : []).map((c) => {
  const p = pickContract(c);
  return {
    id: p.id, companyId: p.companyId, status: p.status,
    frequency: p.frequency, weekdays: p.weekdays, intervalDays: p.intervalDays,
    startsOn: p.startsOn, endsOn: p.endsOn, excludedDates: p.excludedDates,
  };
});

const services: ServiceRecord[] = (Array.isArray(raw.services) ? raw.services : []).map((s) => {
  const p = pickService(s);
  return { ...p, status: p.status as ServiceStatus };
});

const dependencies: Record<string, DependencySignals> = {};
const depsRaw = (raw.dependencies ?? {}) as Record<string, unknown>;
for (const [serviceId, value] of Object.entries(depsRaw)) {
  const d = (value ?? {}) as Record<string, unknown>;
  dependencies[serviceId] = {
    timesheets: num(d.timesheets, 0),
    invoiceItems: num(d.invoiceItems ?? d.invoice_items, 0),
    photos: num(d.photos, 0),
    reinforcements: num(d.reinforcements, 0),
    notifications: num(d.notifications, 0),
    priceAudits: num(d.priceAudits ?? d.price_audits, 0),
  };
}

const snapshot: RepairSnapshot = { window, contracts, services, dependencies };

const problems = validateSnapshot(snapshot);
if (problems.length > 0) {
  console.error("❌ snapshot inválido:");
  for (const p of problems.slice(0, 20)) console.error(`   - ${p}`);
  fail("corrija a exportação antes de continuar");
}

const diagnosis = diagnose(snapshot);
const plan = planRepair(diagnosis, snapshot);
const s = plan.summary;

console.error("");
console.error(`Janela: ${window.start} → ${window.end}`);
console.error(`Ações planeadas: ${s.total}`);
console.error("");
for (const [type, count] of Object.entries(s.byType)) {
  if (count > 0) console.error(`  ${type.padEnd(24, ".")} ${count}`);
}
console.error("");
console.error(`Seguros para fundir ....... ${s.safeToMerge}`);
console.error(`Exigem revisão humana ..... ${s.manualReview}`);
console.error("");
console.error("Este plano NÃO foi executado e este script não sabe executá-lo.");
console.error("");

if (Object.keys(dependencies).length === 0 && diagnosis.summary.duplicateGroups > 0) {
  console.error(
    "⚠ Não foram fornecidas dependências. A escolha do sobrevivente foi feita "
    + "apenas por estado e antiguidade — confirme timesheets, faturas e anexos "
    + "antes de agir sobre qualquer duplicado.",
  );
  console.error("");
}

emit(plan, readArg(argv, "out"));
