// Corrige (idempotente) os timestamps dos serviços FUTUROS `agendado` ligados a
// contratos, recalculando scheduled_start/end a partir do horário do contrato
// com o offset de Europe/Lisbon. Não toca em exceções, passados, ou pontuais.
//
//   node scripts/fix-service-times.mjs          → dry-run (só mostra)
//   node scripts/fix-service-times.mjs --apply  → aplica as alterações
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = fs.readFileSync(".env.local", "utf8").split("\n").reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2].replace(/^"|"$/g, "");
  return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

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
  .eq("status", "ativo");
if (error) { console.error(error.message); process.exit(1); }

let scanned = 0, changed = 0;
for (const c of contracts ?? []) {
  const schedule = c.schedule_days ?? [];
  if (!schedule.length) continue;
  const def = schedule[0];

  const { data: services } = await sb
    .from("services")
    .select("id, reference_number, scheduled_start, scheduled_end, is_exception")
    .eq("contract_id", c.id)
    .eq("status", "agendado")
    .gte("scheduled_start", nowIso);

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
    if (APPLY) {
      const { error: upErr } = await sb.from("services")
        .update({ scheduled_start: newStart, scheduled_end: newEnd })
        .eq("id", s.id);
      if (upErr) console.error(`  ERRO #${s.reference_number}:`, upErr.message);
    }
  }
}
console.log(`\n${APPLY ? "APLICADO" : "DRY-RUN"} — analisados: ${scanned}, a corrigir: ${changed}`);
