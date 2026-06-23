// Importa 5 contratos (planos recorrentes) + 12 intervenções (services) para
// os 5 clientes do export PARTE_1 (= clientes das imagens). Idempotente.
// Uso: node scripts/import-contratos-5.mjs [--dry]
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "./.env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken:false, persistSession:false }});
const C = "00000000-0000-0000-0000-000000000001";
const BY = "03def8bb-f7ae-4963-9a7d-78292b867d73";
const dry = process.argv.includes("--dry");
const TZ = "+01:00"; // Lisboa Jun/Jul (horário de verão)

const T = {
  "Equipa 1":"10473f6d-4e6d-4120-b428-7c4f8d9d39cd","Equipa 3":"1d67cd42-4ca5-4187-88d7-0c1dcdfe0b21",
  "Equipa 4":"b0810dab-8155-471a-989d-0a6797ea6401","Equipa 5":"227d58ff-ede4-4c52-8ddc-26282821b092",
  "Equipa 7":"3ca38ed2-bb1f-481b-8823-be89ba0a67ef","Equipa 8":"b2e93423-3fce-4d4f-88f7-9f5f5c7b7e46",
};
const ST = { "Executada":"concluido", "Agendada":"agendado", "Cancelada":"cancelado" };

// contratos: [loc, nome, frequency, weekdays, day, start, durMin, teamPadrao, starts_on, rate, notes]
const CONTRACTS = {
  729: { loc:"950ca346-118b-40ac-a148-82d8474fff6c", name:"Limpezas-Manutenção-Semanal", frequency:"weekly", weekdays:[1], day:"mon", start:"08:30", dur:90,  team:"Equipa 5", starts:"2025-10-30", rate:10.5 },
  705: { loc:"cfbab39f-7f8a-491b-9fd6-06782ffcc385", name:"Limpezas-Manutenção-Semanal", frequency:"weekly", weekdays:[3], day:"wed", start:"14:30", dur:120, team:"Equipa 7", starts:"2025-10-13", rate:10.25 },
  757: { loc:"0951a3ef-f221-4282-97f6-cfde814fbb14", name:"Limpezas-Manutenção-Semanal", frequency:"weekly", weekdays:[5], day:"fri", start:"08:00", dur:180, team:"Equipa 8", starts:"2025-11-25", rate:10.5 },
  201: { loc:"ef1c16c3-7d47-46b9-b58d-948804d552c5", name:"Limpezas-Manutenção-Quinzenal", frequency:"biweekly", weekdays:[2], day:"tue", start:"12:30", dur:120, team:"Equipa 3", starts:"2025-04-12", rate:10.0 },
  607: { loc:"ee5f108a-78cb-476f-885c-b28eaae972e8", name:"Limpezas-Manutenção-Pontual", frequency:"custom", weekdays:[], day:null, start:null, dur:null, team:null, starts:"2025-08-18", rate:10.5, pontual:true },
};

// intervenções: [svc, ref, date, ini, fim, estado, equipa, valor, rate]
const INTERV = [
  [705,"152325","2026-06-24","14:30","16:30","Cancelada","Equipa 7",41.0,10.25],
  [705,"156707","2026-07-01","13:30","15:30","Agendada","Equipa 4",41.0,10.25],
  [705,"159406","2026-07-08","14:30","16:30","Agendada","Equipa 7",41.0,10.25],
  [729,"151316","2026-06-22","08:30","10:00","Executada","Equipa 4",47.25,10.5],
  [729,"154556","2026-06-29","08:45","10:15","Agendada","Equipa 5",47.25,10.5],
  [729,"158711","2026-07-06","08:30","10:00","Agendada","Equipa 5",47.25,10.5],
  [757,"153621","2026-06-26","08:00","11:00","Agendada","Equipa 8",63.0,10.5],
  [757,"157734","2026-07-03","08:30","11:30","Agendada","Equipa 8",63.0,10.5],
  [757,"160118","2026-07-10","08:00","11:00","Agendada","Equipa 8",63.0,10.5],
  [201,"180679","2026-06-23","10:15","12:15","Agendada","Equipa 1",40.0,10.0],
  [201,"180680","2026-07-07","12:30","14:30","Agendada","Equipa 3",40.0,10.0],
  [201,"180681","2026-07-21","12:30","14:30","Agendada","Equipa 3",40.0,10.0],
];

// 1) Verificar colisão de reference_number
const refs = INTERV.map(i=>i[1]);
const { data: existing } = await sb.from("services").select("reference_number").in("reference_number", refs);
const taken = new Set((existing||[]).map(r=>r.reference_number));
console.log(`Reference_numbers já existentes: ${taken.size ? [...taken].join(",") : "nenhum"}`);

console.log(`\n== A inserir ==\nContratos: ${Object.keys(CONTRACTS).length} | Intervenções: ${INTERV.filter(i=>!taken.has(i[1])).length} (de ${INTERV.length})`);
for (const [svc,c] of Object.entries(CONTRACTS)) console.log(`  contrato svc${svc}: ${c.name} | ${c.frequency} | ${c.day??"pontual"} ${c.start??""} | equipa ${c.team??"—"}`);

if (dry) { console.log("\n--dry: nada escrito."); process.exit(0); }

// 2) Inserir contratos (idempotente por notes marker)
const contractIdBySvc = {};
for (const [svc,c] of Object.entries(CONTRACTS)) {
  const marker = `import:contrato-parte1 svc:${svc}`;
  const { data: ex } = await sb.from("contracts").select("id").eq("company_id",C).like("notes",`%${marker}%`).limit(1);
  if (ex?.length) { contractIdBySvc[svc] = ex[0].id; console.log(`contrato svc${svc} já existe`); continue; }
  const schedule_days = c.day ? [{ day:c.day, start_time:c.start, duration_min:c.dur, team_id:T[c.team] }] : [];
  const row = {
    company_id:C, location_id:c.loc, name:c.name, frequency:c.frequency,
    weekdays:c.weekdays.length?c.weekdays:null, interval_days:c.frequency==="custom"?30:1,
    schedule_days, starts_on:c.starts, status:"ativo",
    notes:`${marker}${c.pontual?" | Pontual (a pedido)":""}`, created_by:BY,
  };
  const { data, error } = await sb.from("contracts").insert(row).select("id").single();
  if (error) { console.error(`ERRO contrato svc${svc}:`, error.message); process.exit(1); }
  contractIdBySvc[svc] = data.id;
  console.log(`contrato svc${svc} criado: ${data.id}`);
}

// 3) Inserir intervenções (services)
let ins = 0;
for (const [svc,ref,date,ini,fim,estado,equipa,valor,rate] of INTERV) {
  if (taken.has(ref)) { console.log(`intervencao ${ref} já existe — saltada`); continue; }
  const row = {
    company_id:C, location_id:CONTRACTS[svc].loc, team_id:T[equipa], contract_id:contractIdBySvc[svc],
    reference_number:String(ref),
    scheduled_start:`${date}T${ini}:00${TZ}`, scheduled_end:`${date}T${fim}:00${TZ}`,
    hourly_rate:rate, manual_value:valor, discount_pct:0, status:ST[estado],
    notes:"import:contrato-parte1",
    created_by:BY,
    ...(estado==="Executada" ? { actual_start:`${date}T${ini}:00${TZ}`, actual_end:`${date}T${fim}:00${TZ}` } : {}),
    ...(estado==="Cancelada" ? { cancelled_at:`${date}T${ini}:00${TZ}`, cancel_reason:"Importado como cancelado (origem)" } : {}),
  };
  const { error } = await sb.from("services").insert(row);
  if (error) { console.error(`ERRO intervencao ${ref}:`, error.message); process.exit(1); }
  ins++;
}
console.log(`\n== CONCLUÍDO == contratos: ${Object.keys(contractIdBySvc).length} | intervenções inseridas: ${ins}`);
