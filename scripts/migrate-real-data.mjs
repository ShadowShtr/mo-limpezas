// ============================================================
// Migração de dados reais — Mó Limpezas
// Ver docs/MIGRACAO_DADOS_REAIS.md
//
// Uso:
//   node scripts/migrate-real-data.mjs --data <ficheiro>.json [--wipe]
//
// --wipe : apaga TODOS os dados demo antes de importar (mantém só os 2
//          utilizadores de teste em KEEP_USER_IDS). Operação destrutiva.
//
// Formato do JSON (normalizado a partir dos Excel exportados):
//   {
//     "colaboradores": [{ "Nome", "Contactos", "Perfil Utilizador", "Utilizador" }],
//     "clientes":      [{ "Nome", "Morada", "Contacto" }],
//     "equipas":       [{ "Nome", "Colaboradores", "Supervisor" }]
//   }
// (qualquer secção pode faltar; aceita também {dados_normalizados:{...records}})
//
// Requer .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// NÃO contém dados pessoais — estes vêm sempre do ficheiro --data (gitignored).
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import crypto from "crypto";
import { readFileSync, writeFileSync } from "fs";

config({ path: "./.env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const COMPANY = "00000000-0000-0000-0000-000000000001";
const ZERO = "00000000-0000-0000-0000-000000000000";
// Utilizadores a preservar numa limpeza (--wipe).
const KEEP_USER_IDS = new Set([
  "03def8bb-f7ae-4963-9a7d-78292b867d73", // Vitor Medina (admin)
  "06e9d9b9-5efe-4548-a64d-4e609215f656", // Vitor Colaborador
]);
const ROLE_MAP = { admin: "admin", supervisor: "gestor", user: "colaborador", semacesso: "colaborador" };
const EMPRESA_RE = /(pr[eé]dio|lavand|alojamento|apartamento|^loja| loja|edif[ií]cio|condom[ií]nio|escrit[oó]rio|caf[eé]|restaurante|cl[ií]nica|hotel|sal[aã]o|gin[aá]sio|^agito|extra$|talho|padaria|merc[ea]|farm[aá]cia)/i;

// --- args ---
const args = process.argv.slice(2);
const dataPath = args[args.indexOf("--data") + 1];
const doWipe = args.includes("--wipe");
if (!dataPath || dataPath.startsWith("--")) {
  console.error("Uso: node scripts/migrate-real-data.mjs --data <ficheiro>.json [--wipe]");
  process.exit(1);
}

// --- helpers ---
const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
const genPwd = () => { let p = ""; for (const x of crypto.randomBytes(10)) p += "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"[x % 56]; return "Mo" + p + "!9"; };

function section(d, key) {
  const n = d.dados_normalizados || d;
  const s = n[key];
  return Array.isArray(s) ? s : (s?.records ?? []);
}

async function deleteAll(table) {
  const { error } = await sb.from(table).delete().neq("id", ZERO);
  if (error) console.log("  wipe", table, "ERR", error.message);
}

async function wipe() {
  console.log("== WIPE: a remover dados demo ==");
  const tables = ["timesheets", "invoices", "cash_flow_entries", "services", "contracts",
    "absences", "vacation_requests", "team_members", "teams", "locations", "clients", "vehicles",
    "notifications", "client_notifications", "payroll_records", "vehicle_allocations",
    "collaborator_documents", "management_tasks", "invoice_items", "service_price_audit",
    "service_reinforcements", "audit_logs"];
  for (const t of tables) await deleteAll(t);
  const { data: au } = await sb.auth.admin.listUsers({ perPage: 1000 });
  let del = 0;
  for (const u of au?.users ?? []) {
    if (KEEP_USER_IDS.has(u.id)) continue;
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (!error) del++; else console.log("  delUser FAIL", u.email, error.message);
  }
  console.log(`  auth users removidos: ${del}`);
}

async function importCollaborators(records) {
  const nameToId = {}, creds = [];
  for (const r of records) {
    const name = r["Nome"].trim();
    const util = (r["Utilizador"] || "").trim();
    const role = ROLE_MAP[(r["Perfil Utilizador"] || "user").trim()] || "colaborador";
    const phone = r["Contactos"] ? String(r["Contactos"]).trim() : null;
    let email, loginType;
    if (util && util.includes("@")) { email = util.toLowerCase(); loginType = "email"; }
    else if (util) { email = slug(util) + "@molimpezas.local"; loginType = "username"; }
    else { email = slug(name) + "@molimpezas.local"; loginType = "username(derivado)"; }
    const password = genPwd();
    const { data: au, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { company_id: COMPANY, role, full_name: name } });
    if (error) { console.log("  collab FAIL", name, error.message); continue; }
    nameToId[name] = au.user.id;
    await sb.from("profiles").update({ phone, status: "ativo", role, full_name: name }).eq("id", au.user.id);
    creds.push({ name, login: email, loginType, role, password });
  }
  writeFileSync("./CREDENCIAIS_COLABORADORES.local.md",
    `# Credenciais provisorias — colaboradores Mo Limpezas\n\nGerado ${new Date().toISOString()}. NAO partilhar. Trocar via 'Recuperar password'.\n\n| Nome | Login | Tipo | Papel | Senha provisoria |\n|---|---|---|---|---|\n` +
    creds.map((c) => `| ${c.name} | ${c.login} | ${c.loginType} | ${c.role} | \`${c.password}\` |`).join("\n") + "\n");
  console.log(`  colaboradores: ${creds.length} (credenciais em CREDENCIAIS_COLABORADORES.local.md)`);
  return nameToId;
}

async function importClients(records) {
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("clients").select("name,phone").range(from, from + 999);
    if (!data?.length) break;
    data.forEach((c) => existing.add((c.name || "").trim() + "|" + (c.phone || "").trim()));
    if (data.length < 1000) break;
  }
  const rows = [];
  for (const r of records) {
    const name = (r["Nome"] || "").trim(); if (!name) continue;
    const phone = r["Contacto"] ? String(r["Contacto"]).trim() : null;
    if (existing.has(name + "|" + (phone || ""))) continue; // anti-duplicado
    rows.push({ company_id: COMPANY, name, address: r["Morada"] ? r["Morada"].trim() : null, phone, type: EMPRESA_RE.test(name) ? "empresa" : "individual", status: "ativo" });
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await sb.from("clients").insert(rows.slice(i, i + 500)).select("id");
    if (error) { console.log("  clients ERR @" + i, error.message); break; }
    inserted += data.length;
  }
  console.log(`  clientes inseridos: ${inserted}`);
}

// Cria 1 local ("Morada principal") por cliente que ainda não tenha local.
async function importLocations() {
  const clients = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("clients").select("id,address").range(from, from + 999);
    if (!data?.length) break; clients.push(...data); if (data.length < 1000) break;
  }
  const withLoc = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("locations").select("client_id").range(from, from + 999);
    if (!data?.length) break; data.forEach((l) => withLoc.add(l.client_id)); if (data.length < 1000) break;
  }
  const rows = clients.filter((c) => c.address && !withLoc.has(c.id))
    .map((c) => ({ company_id: COMPANY, client_id: c.id, name: "Morada principal", address: c.address.trim(), service_type: "limpeza_regular", active: true }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await sb.from("locations").insert(rows.slice(i, i + 500)).select("id");
    if (error) { console.log("  locations ERR @" + i, error.message); break; }
    inserted += data.length;
  }
  console.log(`  locais criados: ${inserted}`);
}

async function importTeams(records, nameToId) {
  const names = Object.keys(nameToId).sort((a, b) => b.length - a.length);
  const parse = (str) => {
    if (!str) return [];
    const s = str.trim(), out = []; let i = 0;
    while (i < s.length) {
      if (s[i] === " ") { i++; continue; }
      let m = null;
      for (const nm of names) { if (s.startsWith(nm, i)) { const e = i + nm.length; if (e === s.length || s[e] === " ") { m = nm; break; } } }
      if (m) { out.push(m); i += m.length; } else { const nx = s.indexOf(" ", i); if (nx < 0) break; i = nx + 1; }
    }
    return out;
  };
  const palette = ["#16A34A", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#06B6D4", "#84CC16", "#A855F7", "#0EA5E9", "#22C55E", "#EAB308", "#F43F5E", "#6366F1"];
  let pi = 0, teamsN = 0, membersN = 0;
  for (const t of records) {
    const leader_id = t["Supervisor"] ? (nameToId[t["Supervisor"].trim()] || null) : null;
    const { data: tin, error } = await sb.from("teams").insert({ company_id: COMPANY, name: t["Nome"].trim(), leader_id, active: true, color: palette[pi++ % palette.length] }).select("id").single();
    if (error) { console.log("  team FAIL", t["Nome"], error.message); continue; }
    teamsN++;
    const members = parse(t["Colaboradores"]).map((nm) => ({ team_id: tin.id, collaborator_id: nameToId[nm] })).filter((m) => m.collaborator_id);
    if (members.length) { const { error: me } = await sb.from("team_members").insert(members); if (!me) membersN += members.length; }
  }
  console.log(`  equipas: ${teamsN} | membros: ${membersN}`);
}

// --- run ---
const data = JSON.parse(readFileSync(dataPath, "utf8"));
if (doWipe) await wipe();
const collabs = section(data, "colaboradores");
const nameToId = collabs.length ? await importCollaborators(collabs) : await (async () => {
  const m = {}; const { data: p } = await sb.from("profiles").select("id,full_name"); p?.forEach((x) => (m[x.full_name] = x.id)); return m;
})();
if (section(data, "clientes").length) await importClients(section(data, "clientes"));
await importLocations();
if (section(data, "equipas").length) await importTeams(section(data, "equipas"), nameToId);
console.log("MIGRAÇÃO CONCLUÍDA.");
