// Atualiza (retroativo) o nº de pessoas e o valor dos serviços FUTUROS `agendado`
// segundo o tamanho da equipa atribuída (ou o override do contrato), recalculando
// calculated_value = horas × valor/hora × nº de pessoas.
// Não toca em serviços passados/concluídos/cancelados, nem em valores por unidade
// (estofos) ou com valor manual.
//
//   node scripts/fix-num-people.mjs          → dry-run
//   node scripts/fix-num-people.mjs --apply  → aplica
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = fs.readFileSync(".env.local", "utf8").split("\n").reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2].replace(/^"|"$/g, "");
  return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");
const nowIso = new Date().toISOString();

// Tamanho de equipa (membros ativos) com cache.
const teamSizeCache = new Map();
async function teamSize(teamId) {
  if (!teamId) return 1;
  if (teamSizeCache.has(teamId)) return teamSizeCache.get(teamId);
  const { count } = await sb.from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId).is("left_at", null);
  const n = count && count > 0 ? count : 1;
  teamSizeCache.set(teamId, n);
  return n;
}

// Override num_people por contrato.
const { data: contracts } = await sb.from("contracts").select("id, num_people");
const contractOverride = new Map((contracts ?? []).map((c) => [c.id, c.num_people]));

const { data: services } = await sb.from("services")
  .select("id, reference_number, scheduled_start, scheduled_end, team_id, contract_id, hourly_rate, calculated_value, manual_value, num_people, upholstery_unit_price")
  .eq("status", "agendado")
  .gte("scheduled_start", nowIso);

let scanned = 0, changed = 0;
for (const s of services ?? []) {
  scanned++;
  const override = s.contract_id ? contractOverride.get(s.contract_id) : null;
  const people = override != null && override >= 1 ? Math.floor(override) : await teamSize(s.team_id);

  // Valor por unidade (estofos) ou valor manual → só ajusta num_people, não o valor.
  const unitBased = s.upholstery_unit_price != null;
  const durationMin = Math.max(0, Math.round((new Date(s.scheduled_end) - new Date(s.scheduled_start)) / 60000));
  const newValue = (!unitBased && s.hourly_rate != null)
    ? parseFloat(((durationMin / 60) * s.hourly_rate * people).toFixed(2))
    : s.calculated_value;

  const peopleChanged = (s.num_people ?? 1) !== people;
  const valueChanged = newValue !== s.calculated_value;
  if (!peopleChanged && !valueChanged) continue;

  changed++;
  console.log(`#${s.reference_number} pessoas ${s.num_people}→${people} | valor ${s.calculated_value}→${newValue}`);
  if (APPLY) {
    const { error } = await sb.from("services")
      .update({ num_people: people, calculated_value: newValue })
      .eq("id", s.id);
    if (error) console.error(`  ERRO #${s.reference_number}:`, error.message);
  }
}
console.log(`\n${APPLY ? "APLICADO" : "DRY-RUN"} — analisados: ${scanned}, a corrigir: ${changed}`);
