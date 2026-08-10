// Corrige (idempotente) os timestamps dos serviços FUTUROS `agendado` ligados a
// contratos, recalculando scheduled_start/end a partir do horário do contrato
// com o offset de Europe/Lisbon. Não toca em exceções, passados, ou pontuais.
//
//   node scripts/fix-service-times.mjs --project-ref <ref> --company-id <uuid>
//   node scripts/fix-service-times.mjs --project-ref <ref> --company-id <uuid> --apply
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "fix-service-times.mjs",
  purpose: "recalcular scheduled_start/end de serviços agendados futuros com o offset de Lisboa",
  writes: true,
});
const sb = db.sb;

const DOW_TO_KEY = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

function lisbonOffset(dateStr) {
  const midday = new Date(`${dateStr}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", timeZoneName: "shortOffset" })
    .formatToParts(midday).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}
function toLisbon(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00${lisbonOffset(dateStr)}`;
}
function addMins(time, mins) {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.min(Math.floor(total / 60), 23)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const nowIso = new Date().toISOString();

const { data: contracts, error } = await sb
  .from("contracts")
  .select("id, schedule_days, status")
  .eq("company_id", db.companyId)
  .eq("status", "ativo");
if (error) { console.error(error.message); process.exit(1); }

let scanned = 0, changed = 0;
for (const c of contracts ?? []) {
  const schedule = c.schedule_days ?? [];
  if (!schedule.length) continue;
  const def = schedule[0];

  const { data: services, error: servicesError } = await sb
    .from("services")
    .select("id, reference_number, scheduled_start, scheduled_end, is_exception")
    .eq("company_id", db.companyId)
    .eq("contract_id", c.id)
    .eq("status", "agendado")
    .gte("scheduled_start", nowIso);
  // Sem isto, uma consulta falhada dá lista vazia e o contrato passa por
  // "nada a corrigir" — o padrão que a T17-B1 contou 268 vezes na aplicação.
  if (servicesError) throw new Error(`services (contrato ${c.id}): ${servicesError.message}`);

  for (const s of services ?? []) {
    if (s.is_exception) continue;
    scanned++;
    const dateStr = s.scheduled_start.slice(0, 10);
    const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    const day = schedule.find((x) => x.day === DOW_TO_KEY[dow]) ?? def;
    const endTime = addMins(day.start_time, day.duration_min);

    // Assinatura do bug "naive": o instante guardado é exatamente a hora do
    // contrato interpretada como UTC (ex.: 07:45 -> 07:45Z em vez de 06:45Z).
    // Só corrigimos NESSE caso. Linhas já corretas (offset Lisboa) e
    // reagendamentos manuais (hora diferente do padrão) ficam intactos.
    const naiveStartInstant = new Date(`${dateStr}T${day.start_time}:00Z`).getTime();
    if (new Date(s.scheduled_start).getTime() !== naiveStartInstant) continue;

    const newStart = toLisbon(dateStr, day.start_time);
    const newEnd = toLisbon(dateStr, endTime);

    // No-op (ex.: inverno, offset Lisboa = +00:00): nada a alterar.
    if (new Date(newStart).getTime() === new Date(s.scheduled_start).getTime()) continue;

    changed++;
    console.log(`#${s.reference_number} ${s.scheduled_start} -> ${newStart}`);
    await db.write(
      "services",
      (t) => t.update({ scheduled_start: newStart, scheduled_end: newEnd })
        .eq("id", s.id).eq("company_id", db.companyId),
      `#${s.reference_number}`,
    );
  }
}
console.log(`\nAnalisados: ${scanned}, a corrigir: ${changed}`);
db.summary();
