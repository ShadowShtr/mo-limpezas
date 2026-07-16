// Corrige serviços FUTUROS `agendado` de contratos mensais/personalizados que
// caíram em sábado/domingo (a geração agora empurra para a próxima 2ª feira,
// mas isto só se aplica a partir de agora — ocorrências já gravadas antes do
// fix ficam como estavam até este script correr). Nunca mexe em passados,
// concluídos, cancelados, exceções já movidas à mão, nem em semanal/
// quinzenal/3-em-3-semanas (dia da semana aí é escolha explícita).
//
//   node scripts/fix-weekend-services.mjs          → dry-run (só mostra)
//   node scripts/fix-weekend-services.mjs --apply  → aplica as alterações
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = fs.readFileSync(".env.local", "utf8").split("\n").reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2].replace(/^"|"$/g, "");
  return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

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
function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const nowIso = new Date().toISOString();

const { data: services, error } = await sb
  .from("services")
  .select("id, reference_number, company_id, contract_id, team_id, scheduled_start, scheduled_end, is_exception, status, contracts!inner(frequency)")
  .eq("status", "agendado")
  .eq("is_exception", false)
  .gte("scheduled_start", nowIso)
  .in("contracts.frequency", ["monthly", "custom"]);

if (error) { console.error(error.message); process.exit(1); }

let scanned = 0, weekend = 0, moved = 0, skippedConflict = 0;

for (const s of services ?? []) {
  scanned++;
  const startDateStr = s.scheduled_start.slice(0, 10);
  const endDateStr = s.scheduled_end.slice(0, 10);
  const startTime = s.scheduled_start.slice(11, 16);
  const endTime = s.scheduled_end.slice(11, 16);
  const dow = new Date(`${startDateStr}T12:00:00Z`).getUTCDay();
  if (dow !== 0 && dow !== 6) continue;
  weekend++;

  const shiftDays = dow === 6 ? 2 : 1; // sáb +2, dom +1 → segunda
  const newDateStr = addDaysToDateStr(startDateStr, shiftDays);
  // scheduled_end pode cair no dia seguinte (turno da noite) — desloca o mesmo nº de dias que o início.
  const newEndDateStr = addDaysToDateStr(endDateStr, shiftDays);

  const newStart = toLisbon(newDateStr, startTime);
  const newEnd = toLisbon(newEndDateStr, endTime);

  // Conflito 1: já existe outro serviço deste MESMO contrato no novo dia (evita duplicar a ocorrência).
  const { data: dupContract } = await sb
    .from("services")
    .select("id")
    .eq("contract_id", s.contract_id)
    .neq("id", s.id)
    .gte("scheduled_start", `${newDateStr}T00:00:00`)
    .lt("scheduled_start", `${newDateStr}T23:59:59`)
    .maybeSingle();

  // Conflito 2: a equipa já tem outro serviço a sobrepor-se no novo horário.
  let teamConflict = null;
  if (s.team_id) {
    const { data } = await sb
      .from("services")
      .select("id, reference_number")
      .eq("team_id", s.team_id)
      .neq("id", s.id)
      .in("status", ["agendado", "em_curso"])
      .lt("scheduled_start", newEnd)
      .gt("scheduled_end", newStart)
      .maybeSingle();
    teamConflict = data;
  }

  if (dupContract || teamConflict) {
    skippedConflict++;
    console.log(`⚠️  #${s.reference_number} (${startDateStr}) — conflito, NÃO movido automaticamente: ` +
      (dupContract ? "já há serviço deste contrato no novo dia" : `equipa ocupada (serviço #${teamConflict.reference_number})`));
    continue;
  }

  moved++;
  console.log(`#${s.reference_number}: ${s.scheduled_start} (${["dom","seg","ter","qua","qui","sex","sáb"][dow]}) → ${newStart}`);
  if (APPLY) {
    const { error: upErr } = await sb.from("services")
      .update({
        scheduled_start: newStart,
        scheduled_end: newEnd,
        is_exception: true,
        original_date: startDateStr,
      })
      .eq("id", s.id);
    if (upErr) console.error(`  ERRO #${s.reference_number}:`, upErr.message);
  }
}

console.log(`\n${APPLY ? "APLICADO" : "DRY-RUN"} — analisados: ${scanned}, em fim de semana: ${weekend}, ` +
  `${APPLY ? "movidos" : "a mover"}: ${moved}, com conflito (não mexidos): ${skippedConflict}.`);
