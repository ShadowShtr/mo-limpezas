// Atualiza (retroativo) o nº de pessoas e o valor dos serviços FUTUROS `agendado`
// segundo o tamanho da equipa atribuída (ou o override do contrato), recalculando
// calculated_value = horas × valor/hora × nº de pessoas.
// Não toca em serviços passados/concluídos/cancelados, nem em valores por unidade
// (estofos) ou com valor manual.
//
//   node scripts/fix-num-people.mjs --project-ref <ref> --company-id <uuid>
//   node scripts/fix-num-people.mjs --project-ref <ref> --company-id <uuid> --apply
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "fix-num-people.mjs",
  purpose: "corrigir num_people e calculated_value em serviços agendados futuros",
  writes: true,
});
const sb = db.sb;
const nowIso = new Date().toISOString();

// Tamanho de equipa (membros ativos) com cache.
const teamSizeCache = new Map();
async function teamSize(teamId) {
  if (!teamId) return 1;
  if (teamSizeCache.has(teamId)) return teamSizeCache.get(teamId);
  const { count, error } = await sb.from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("company_id", db.companyId)
    .eq("team_id", teamId).is("left_at", null);
  // Um erro aqui daria equipa de 1 pessoa e recalcularia o valor de todos os
  // serviços dessa equipa para baixo. Nunca silenciar.
  if (error) throw new Error(`team_members (${teamId}): ${error.message}`);
  const n = count && count > 0 ? count : 1;
  teamSizeCache.set(teamId, n);
  return n;
}

// Override num_people por contrato.
const { data: contracts, error: contractsError } = await sb.from("contracts")
  .select("id, num_people")
  .eq("company_id", db.companyId);
if (contractsError) throw new Error(`contracts: ${contractsError.message}`);
const contractOverride = new Map((contracts ?? []).map((c) => [c.id, c.num_people]));

const { data: services, error: servicesError } = await sb.from("services")
  .select("id, reference_number, scheduled_start, scheduled_end, team_id, contract_id, hourly_rate, calculated_value, manual_value, num_people, upholstery_unit_price")
  .eq("company_id", db.companyId)
  .eq("status", "agendado")
  .gte("scheduled_start", nowIso);
if (servicesError) throw new Error(`services: ${servicesError.message}`);

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
  await db.write(
    "services",
    (t) => t.update({ num_people: people, calculated_value: newValue })
      .eq("id", s.id).eq("company_id", db.companyId),
    `#${s.reference_number}`,
  );
}
console.log(`\nAnalisados: ${scanned}, a corrigir: ${changed}`);
db.summary();
