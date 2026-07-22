// ============================================================================
// AUDITORIA DE REVERSÕES — "alterações que desaparecem ou voltam atrás"
// ============================================================================
//
// Diagnostica, de forma 100% READ-ONLY, todas as fontes conhecidas do sintoma
// "gravei e depois o valor voltou ao antigo / a alteração não aparece":
//
//   1. GIT & DEPLOY      — commits locais que nunca chegaram ao GitHub/produção;
//                          deploys por CLI misturados com deploys por git push.
//   2. VERSÃO EM PROD    — que commit está realmente no ar (via /api/health).
//   3. SCHEMA vs MIGRAÇÕES — para cada .sql, verifica se as tabelas/colunas/views
//                          que ele cria existem mesmo na base de produção.
//   4. SEED EM PRODUÇÃO  — dados fictícios do seed.sql contaminaram a base real?
//   5. CLIENTES          — type/notes apagados por edição parcial (recuperável
//                          pelo audit_log).
//   6. CONTRATOS/AVENÇAS — valores fixos zerados em contratos ativos.
//   7. CALENDÁRIO        — sobreposições (interseções), horários anómalos
//                          (sintoma de fuso), serviços mensais ao fim de semana,
//                          e "flip-flops" (mesmo serviço movido para trás e para
//                          a frente em minutos = duas sessões a pisar-se).
//   8. PIPELINE DE MIGRAÇÃO — o próprio run-migrations.mjs é seguro?
//   9. SERVICE WORKER    — a cache do PWA pode segurar código antigo?
//
// Uso:
//   node scripts/audit-reversoes.mjs            # relatório completo
//   node scripts/audit-reversoes.mjs --skip-db  # só verificações locais (sem rede)
//
// Sai com código 1 se houver achados de gravidade ❌ (para usar em CI).
// ============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SKIP_DB = process.argv.includes("--skip-db");

// ── .env.local ───────────────────────────────────────────────────────────────
function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

// ── infra de relatório ───────────────────────────────────────────────────────
const findings = []; // { level: "ok"|"warn"|"fail", section, msg, fix? }
const ICON = { ok: "✅", warn: "⚠️ ", fail: "❌" };
let currentSection = "";

function section(title) {
  currentSection = title;
  console.log(`\n${"═".repeat(74)}\n${title}\n${"═".repeat(74)}`);
}
function report(level, msg, fix) {
  findings.push({ level, section: currentSection, msg, fix });
  console.log(`${ICON[level]} ${msg}`);
  if (fix) console.log(`   ↳ Correção: ${fix}`);
}
function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. GIT & DEPLOY
// ════════════════════════════════════════════════════════════════════════════
function auditGit() {
  section("1. GIT & DEPLOY — o código corrigido chegou mesmo a produção?");

  try { sh("git fetch origin --quiet"); } catch { report("warn", "git fetch falhou (sem rede?) — comparação com origin pode estar desatualizada."); }

  const branch = sh("git rev-parse --abbrev-ref HEAD");
  const counts = sh(`git rev-list --left-right --count ${branch}...origin/${branch}`).split(/\s+/);
  const ahead = Number(counts[0] ?? 0);
  const behind = Number(counts[1] ?? 0);

  if (ahead > 0) {
    const list = sh(`git log --oneline origin/${branch}..${branch}`).split("\n").slice(0, 10).join("\n      ");
    report("fail",
      `O branch local está ${ahead} commit(s) À FRENTE do GitHub. Estes fixes NÃO estão em produção:\n      ${list}`,
      "git push origin " + branch + " (depois de rever) — enquanto não fizeres push, produção continua com os bugs 'já corrigidos'.");
  } else {
    report("ok", "Local e origin sincronizados (0 commits por publicar).");
  }
  if (behind > 0) {
    report("warn", `O branch local está ${behind} commit(s) ATRÁS do origin — outra sessão/máquina fez push. Um push forçado daqui reverteria esse trabalho.`,
      "git pull --rebase antes de qualquer push.");
  }

  const dirty = sh("git status --porcelain");
  if (dirty) {
    const nLines = dirty.split("\n").length;
    report("warn", `${nLines} ficheiro(s) modificados/não versionados no working tree. Trabalho não commitado não chega a produção e pode perder-se.\n      ${dirty.split("\n").slice(0, 12).join("\n      ")}`);
    const untrackedMigrations = dirty.split("\n").filter((l) => l.startsWith("??") && l.includes("supabase/migrations"));
    if (untrackedMigrations.length) {
      report("fail", `Migrações FORA do git: ${untrackedMigrations.map((l) => l.slice(3)).join(", ")}. Se forem aplicadas à base mas o código não for deployado (ou vice-versa), o site quebra ou grava em colunas que 'não existem'.`,
        "Commitar migração + código que a usa SEMPRE no mesmo commit/push.");
    }
  } else {
    report("ok", "Working tree limpo.");
  }

  if (existsSync(join(ROOT, ".vercel", "output"))) {
    report("warn", "Existe .vercel/output — já foram feitos builds/deploys por CLI a partir deste PC. Misturar 'vercel deploy' local com deploys automáticos do GitHub faz o site ALTERNAR entre versões (a origem nº 1 de 'alterações que voltam').",
      "Escolher UM canal só: deploy automático via git push. Nunca mais 'vercel --prod' manual.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. VERSÃO EM PRODUÇÃO
// ════════════════════════════════════════════════════════════════════════════
async function auditDeployedVersion() {
  section("2. VERSÃO EM PRODUÇÃO — que commit está no ar?");
  // AUDIT_APP_URL tem prioridade — o NEXT_PUBLIC_APP_URL do .env.local costuma
  // apontar para localhost e não serve para interrogar produção.
  const url = process.env.AUDIT_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) { report("warn", "AUDIT_APP_URL/NEXT_PUBLIC_APP_URL não definidos — não consigo interrogar o site em produção."); return; }
  if (/localhost|127\.0\.0\.1/.test(url)) {
    report("warn", `O URL configurado (${url}) é localhost — define AUDIT_APP_URL=https://<dominio-em-producao> no .env.local para esta verificação apontar ao site real.`);
    return;
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { report("fail", `/api/health devolveu ${res.status} — produção pode estar em baixo.`); return; }

    if (!body.version) {
      report("warn", "/api/health em produção ainda NÃO devolve a versão (commit). Sem isto é impossível provar que versão está no ar quando alguém diz 'a alteração voltou atrás'.",
        "Deployar o novo /api/health (devolve version = VERCEL_GIT_COMMIT_SHA).");
      return;
    }
    const localHead = sh("git rev-parse --short=7 HEAD");
    const originHead = sh("git rev-parse --short=7 origin/" + sh("git rev-parse --abbrev-ref HEAD"));
    console.log(`   produção=${body.version}  local=${localHead}  origin=${originHead}`);
    if (body.version === localHead) report("ok", "Produção está exatamente no commit local.");
    else if (body.version === originHead) report("warn", "Produção está no commit do GitHub, mas o local tem commits mais recentes por publicar (ver secção 1).");
    else report("fail", `Produção está num commit (${body.version}) que não é nem o HEAD local nem o do GitHub — provável deploy manual antigo por CLI.`,
      "Fazer git push e deixar o deploy automático repor a versão correta.");
  } catch (e) {
    report("warn", `Não consegui contactar ${url}/api/health (${e.message}).`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. SCHEMA vs MIGRAÇÕES  (sondagem automática derivada dos próprios .sql)
// ════════════════════════════════════════════════════════════════════════════
function parseMigrationProbes(sql) {
  // Extrai objetos verificáveis via PostgREST: tabelas, colunas e views em public.
  const probes = { tables: new Set(), columns: [], buckets: new Set() };
  for (const stmtRaw of sql.split(";")) {
    const stmt = stmtRaw.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
    let m;
    if ((m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/i))) probes.tables.add(m[1]);
    if ((m = stmt.match(/^CREATE (?:OR REPLACE )?VIEW (?:public\.)?(\w+)/i))) probes.tables.add(m[1]);
    if ((m = stmt.match(/^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?(\w+)/i))) {
      const table = m[1];
      for (const cm of stmt.matchAll(/ADD (?:COLUMN )?(?:IF NOT EXISTS )?"?(\w+)"?/gi)) {
        // ADD CONSTRAINT/PRIMARY/UNIQUE/etc. não são colunas — ignorar.
        if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(cm[1])) continue;
        probes.columns.push({ table, column: cm[1] });
      }
    }
    if ((m = stmt.match(/INSERT INTO storage\.buckets[^(]*\([^)]*\)\s*(?:SELECT|VALUES)\s*\(?\s*'([^']+)'/i))) probes.buckets.add(m[1]);
  }
  // auth./storage. tables não são sondáveis via REST
  probes.tables = [...probes.tables].filter((t) => !/^(auth|storage)\./.test(t));
  return probes;
}

async function auditSchema(admin) {
  section("3. SCHEMA vs MIGRAÇÕES — o que cada .sql cria existe mesmo em produção?");
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const probeTable = async (t) => {
    const { error } = await admin.from(t).select("*", { head: true, count: "exact" }).limit(0);
    return !error;
  };
  const probeColumn = async (t, c) => {
    const { error } = await admin.from(t).select(c, { head: true }).limit(0);
    return !error;
  };

  let buckets = null;
  try { const { data } = await admin.storage.listBuckets(); buckets = new Set((data ?? []).map((b) => b.id ?? b.name)); } catch { /* sem acesso */ }

  const missingByFile = [];
  for (const file of files) {
    const probes = parseMigrationProbes(readFileSync(join(dir, file), "utf8"));
    const missing = [];
    for (const t of probes.tables) if (!(await probeTable(t))) missing.push(`tabela/view ${t}`);
    for (const { table, column } of probes.columns) {
      if (!(await probeTable(table))) { missing.push(`tabela ${table}`); continue; }
      if (!(await probeColumn(table, column))) missing.push(`${table}.${column}`);
    }
    if (buckets) for (const b of probes.buckets) if (!buckets.has(b)) missing.push(`bucket ${b}`);
    if (missing.length) missingByFile.push({ file, missing: [...new Set(missing)] });
  }

  if (missingByFile.length === 0) {
    report("ok", `Sondados ${files.length} ficheiros de migração — todos os objetos verificáveis existem em produção.`);
  } else {
    for (const { file, missing } of missingByFile) {
      report("fail", `Migração ${file} NÃO está (totalmente) aplicada em produção. Em falta: ${missing.join(", ")}.`,
        "Aplicar com o run-migrations.mjs corrigido (com tabela de controlo _migrations).");
    }
  }
  console.log("   (funções, triggers e policies não são verificáveis via REST — confirmar no SQL editor do Supabase se houver suspeita)");
}

// ════════════════════════════════════════════════════════════════════════════
// 4. SEED EM PRODUÇÃO
// ════════════════════════════════════════════════════════════════════════════
async function auditSeedContamination(admin) {
  section("4. SEED — dados fictícios do seed.sql na base de produção?");
  const seedClientIds = [1, 2, 3, 4, 5].map((n) => `10000000-0000-0000-0000-00000000000${n}`);
  const { data: fake } = await admin.from("clients").select("id, name").in("id", seedClientIds);
  if (fake?.length) {
    report("fail", `${fake.length} cliente(s) FICTÍCIOS do seed em produção: ${fake.map((c) => c.name).join(", ")}. O run-migrations.mjs antigo aplicava o seed.sql (marcado 'NÃO executar em produção') em todos os runs.`,
      "Apagar via dashboard após confirmar que não têm serviços reais associados; usar o run-migrations corrigido que nunca aplica seed.");
  } else {
    report("ok", "Nenhum cliente fictício do seed encontrado em produção.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. CLIENTES — perdas de type/notes (o bug da edição pela lista)
// ════════════════════════════════════════════════════════════════════════════
async function auditClientes(admin) {
  section("5. CLIENTES — campos apagados por edição parcial");

  const { data: wipes } = await admin
    .from("audit_log")
    .select("entity_id, before, after, created_at")
    .eq("action", "client_type_notes_changed")
    .order("created_at", { ascending: false })
    .limit(200);

  const lost = (wipes ?? []).filter((w) => {
    const b = w.before ?? {}, a = w.after ?? {};
    return (b.notes && !a.notes) || (b.type && b.type !== a.type && (!a.type || a.type === "empresa"));
  });
  if (lost.length) {
    report("warn", `${lost.length} edição(ões) no audit_log em que type/notes foram apagados/alterados — valores antigos RECUPERÁVEIS no campo 'before'. Últimos: ${lost.slice(0, 5).map((w) => `${w.entity_id.slice(0, 8)} em ${w.created_at.slice(0, 10)}`).join("; ")}.`,
      "Restaurar a partir do audit_log (before) os que a gestora confirmar terem sido perda acidental.");
  } else if ((wipes ?? []).length === 0) {
    report("warn", "Sem entradas 'client_type_notes_changed' no audit_log — ou nunca houve perdas depois do fix, ou o fix (commit 2eb8154) ainda não está em produção e as perdas continuam SEM registo.",
      "Publicar os commits pendentes (secção 1) para ativar a auditoria destes campos.");
  } else {
    report("ok", "Auditoria de type/notes ativa e sem perdas detetadas.");
  }

  const { count: nullType } = await admin.from("clients")
    .select("id", { count: "exact", head: true }).is("notes", null).eq("status", "ativo");
  console.log(`   (informativo: ${nullType ?? "?"} clientes ativos sem notas — nem todos são perda, muitos nunca tiveram)`);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. CONTRATOS — avenças zeradas, duplicadas e locais por-hora sem valor
// ════════════════════════════════════════════════════════════════════════════
async function auditContratos(admin) {
  section("6. CONTRATOS — avenças zeradas/duplicadas e valor/hora dos locais");
  const { data: broken, error } = await admin
    .from("contracts")
    .select("id, name, status, fixed_monthly, fixed_price, locations(name, clients(name))")
    .eq("status", "ativo")
    .eq("fixed_monthly", true)
    .or("fixed_price.is.null,fixed_price.eq.0");

  if (error) { report("warn", `Não consegui verificar contratos (${error.message}) — colunas fixed_monthly/fixed_price podem não existir ainda (ver secção 3).`); return; }

  if (broken?.length) {
    report("fail", `${broken.length} contrato(s) ATIVOS de avença mensal SEM valor (fixed_price nulo/0): ${broken.slice(0, 8).map((c) => c.locations?.clients?.name ?? c.name ?? c.id.slice(0, 8)).join("; ")}. Sintoma do bug 'editar pela ficha do cliente apaga a avença' (fix e999852) — e os serviços gerados a partir deles ficam a 0€.`,
      "Repor valores (procurar 'contract' no audit_log / faturas antigas) e publicar o fix pendente.");
  } else {
    report("ok", "Nenhum contrato ativo de avença sem valor.");
  }

  // 6b. Avenças mensais DUPLICADAS: 2+ contratos fixed_monthly ativos para o
  //     mesmo local com períodos sobrepostos → cobrança gera 2 linhas iguais.
  const { data: monthlies } = await admin
    .from("contracts")
    .select("id, location_id, starts_on, ends_on, fixed_price, locations(name, clients(name))")
    .eq("status", "ativo")
    .eq("fixed_monthly", true);
  const byLoc = new Map();
  for (const c of monthlies ?? []) {
    if (!byLoc.has(c.location_id)) byLoc.set(c.location_id, []);
    byLoc.get(c.location_id).push(c);
  }
  const dupGroups = [];
  for (const [loc, list] of byLoc) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const overlap = (a.starts_on ?? "0000") <= (b.ends_on ?? "9999") && (b.starts_on ?? "0000") <= (a.ends_on ?? "9999");
      if (overlap) { dupGroups.push({ loc, a, b }); break; }
    }
  }
  if (dupGroups.length) {
    report("fail", `${dupGroups.length} local(is) com contratos de avença mensal DUPLICADOS (períodos sobrepostos): ${dupGroups.slice(0, 5).map((g) => `${g.a.locations?.clients?.name ?? "?"} / ${g.a.locations?.name ?? g.loc}`).join("; ")}. Cada duplicado gera 2 linhas iguais na cobrança (caso Parque Norte).`,
      "Encerrar/ajustar um dos contratos de cada par; a geração de faturas já bloqueia, mas os dados têm de ser corrigidos.");
  } else {
    report("ok", "Sem contratos de avença mensal duplicados por local/período.");
  }

  // 6c. Contratos por hora ativos cujo local está sem hourly_rate
  //     (sintoma do `locations.hourly_rate = input.hourly_rate ?? null`).
  const { data: hourly } = await admin
    .from("contracts")
    .select("id, location_id")
    .eq("status", "ativo")
    .eq("fixed_monthly", false)
    .or("fixed_price.is.null,fixed_price.eq.0");
  const hourlyLocIds = [...new Set((hourly ?? []).map((c) => c.location_id))];
  if (hourlyLocIds.length) {
    const { data: bareLocs } = await admin
      .from("locations")
      .select("id, name, clients(name)")
      .in("id", hourlyLocIds)
      .is("hourly_rate", null);
    if (bareLocs?.length) {
      report("fail", `${bareLocs.length} local(is) com contrato POR HORA ativo mas hourly_rate NULO: ${bareLocs.slice(0, 6).map((l) => `${l.clients?.name ?? "?"} / ${l.name}`).join("; ")}. Provável vítima do update cego 'hourly_rate ?? null' em contratos.ts:428/:554 — serviços por hora destes locais calculam 0€.`,
        "Repor o valor/hora (audit_log location_updated tem o before) e aplicar o fix da Causa 7 do roteiro.");
    } else {
      report("ok", "Todos os locais com contratos por hora ativos têm hourly_rate definido.");
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. CALENDÁRIO — interseções, fuso, fins de semana, flip-flops
// ════════════════════════════════════════════════════════════════════════════
async function auditCalendario(admin) {
  section("7. CALENDÁRIO — sobreposições, horários anómalos e edições em corrida");

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const until = new Date(Date.now() + 60 * 86400000).toISOString();
  const { data: svcs } = await admin
    .from("services")
    .select("id, team_id, scheduled_start, scheduled_end, status, location_id")
    .gte("scheduled_start", since).lte("scheduled_start", until)
    .in("status", ["agendado", "em_curso"])
    .order("scheduled_start");

  // 7a. Interseções: mesma equipa, horários sobrepostos
  const byTeam = new Map();
  for (const s of svcs ?? []) {
    if (!s.team_id) continue;
    if (!byTeam.has(s.team_id)) byTeam.set(s.team_id, []);
    byTeam.get(s.team_id).push(s);
  }
  const overlaps = [];
  for (const list of byTeam.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (new Date(b.scheduled_start) >= new Date(a.scheduled_end)) break;
        overlaps.push([a, b]);
      }
    }
  }
  if (overlaps.length) {
    report("warn", `${overlaps.length} par(es) de serviços SOBREPOSTOS na mesma equipa (interseções). Ex.: ${overlaps.slice(0, 3).map(([a, b]) => `${a.id.slice(0, 8)}×${b.id.slice(0, 8)} @ ${a.scheduled_start.slice(0, 16)}`).join("; ")}.`,
      "Rever no calendário; a maioria nasce de drags 'forçados' ou de duas sessões a agendar em simultâneo.");
  } else {
    report("ok", "Sem sobreposições de serviços na mesma equipa (janela -30/+60 dias).");
  }

  // 7b. Horários anómalos (sintoma de fuso errado: gravado como UTC deslocado)
  const hourInLisbon = (iso) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "numeric", hour12: false }).format(new Date(iso)));
  const weird = (svcs ?? []).filter((s) => { const h = hourInLisbon(s.scheduled_start); return h < 6 || h >= 21; });
  if (weird.length) {
    report("warn", `${weird.length} serviço(s) com início fora de 06h–21h de Lisboa (ex.: ${weird.slice(0, 3).map((s) => s.scheduled_start).join("; ")}). Padrão típico de datas gravadas com fuso errado — 'o serviço mudou de hora sozinho'.`,
      "Verificar e corrigir; garantir que TODAS as escritas passam por ensureLisbonOffset (lib/lisbon-time).");
  } else {
    report("ok", "Nenhum serviço com horário anómalo (fuso aparenta consistente).");
  }

  // 7c. Fim de semana em contratos mensais/personalizados (fix e46301e)
  const dayInLisbon = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", weekday: "short" }).format(new Date(iso));
  const weekend = (svcs ?? []).filter((s) => ["Sat", "Sun"].includes(dayInLisbon(s.scheduled_start)));
  console.log(`   (informativo: ${weekend.length} serviços agendados a sáb/dom na janela — confirmar se são intencionais)`);

  // 7d. Flip-flops no audit_log: mesmo serviço re-agendado 2+ vezes em <10 min
  const { data: moves } = await admin
    .from("audit_log")
    .select("entity_id, actor_id, created_at, before, after")
    .in("action", ["service_rescheduled_drag_drop", "service_updated"])
    .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString())
    .order("created_at");
  const byEntity = new Map();
  for (const m of moves ?? []) {
    if (!byEntity.has(m.entity_id)) byEntity.set(m.entity_id, []);
    byEntity.get(m.entity_id).push(m);
  }
  const flipflops = [];
  for (const [id, list] of byEntity) {
    for (let i = 1; i < list.length; i++) {
      const dt = new Date(list[i].created_at) - new Date(list[i - 1].created_at);
      const differentActor = list[i].actor_id !== list[i - 1].actor_id;
      const undone = JSON.stringify(list[i].after ?? {}) === JSON.stringify(list[i - 1].before ?? {});
      if (dt < 10 * 60000 && (differentActor || undone)) flipflops.push({ id, at: list[i].created_at, differentActor, undone });
    }
  }
  if (flipflops.length) {
    report("warn", `${flipflops.length} caso(s) de EDIÇÕES EM CORRIDA nos últimos 14 dias (mesmo serviço alterado 2× em <10 min ${flipflops.some((f) => f.differentActor) ? "por atores diferentes" : ""}${flipflops.some((f) => f.undone) ? "; inclui reversões exatas ao valor anterior" : ""}). É a assinatura de duas sessões abertas a pisarem-se (last-write-wins).`,
      "Manter UMA sessão de gestão por vez até haver verificação de concorrência (updated_at) nas server actions.");
  } else {
    report("ok", "Sem padrão de edições em corrida no audit_log (14 dias).");
  }

  // 7e. Serviços de contrato editados à mão SEM is_exception → em risco de
  //     serem revertidos pela próxima edição do contrato (Causa "is_exception
  //     nunca é escrito"). Quantifica o problema com dados reais.
  const movedIds = [...new Set((moves ?? []).map((m) => m.entity_id))];
  if (movedIds.length) {
    const { data: atRisk } = await admin
      .from("services")
      .select("id, scheduled_start, contract_id, is_exception, status")
      .in("id", movedIds.slice(0, 500))
      .not("contract_id", "is", null)
      .eq("is_exception", false)
      .eq("status", "agendado");
    if (atRisk?.length) {
      report("fail", `${atRisk.length} serviço(s) de CONTRATO editados manualmente (audit_log, 14 dias) continuam com is_exception=false e status agendado — a PRÓXIMA edição do contrato reverte-os para o padrão (horário/equipa/valor). É a materialização do 'alterei e depois voltou'.`,
        "Aplicar o fix da Causa 5 (marcar is_exception nas edições manuais) e, para estes casos já existentes, marcar is_exception=true à mão ou re-confirmar as edições depois do fix.");
    } else {
      report("ok", "Nenhum serviço de contrato editado recentemente está em risco de reversão (ou não houve edições).");
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 10. ESCRITAS DIRETAS DO BROWSER — updates sem server action (RLS silencioso)
// ════════════════════════════════════════════════════════════════════════════
function auditClientSideWrites() {
  section("10. ESCRITAS DIRETAS DO BROWSER — components 'use client' a escrever na base");
  const CRITICAL_TABLES = ["services", "contracts", "clients", "locations", "invoices", "invoice_items"];
  const offenders = [];

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const src = readFileSync(p, "utf8");
      if (!/^\s*["']use client["']/m.test(src.slice(0, 400))) continue;
      for (const t of CRITICAL_TABLES) {
        const re = new RegExp(`from\\(["']${t}["']\\)[\\s\\S]{0,120}?\\.(update|insert|delete)\\(`, "g");
        let m;
        while ((m = re.exec(src)) !== null) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push({ file: p.replace(ROOT + "\\", "").replace(/\\/g, "/"), table: t, op: m[1], line });
        }
      }
    }
  };
  walk(join(ROOT, "src"));

  if (offenders.length) {
    report("fail", `${offenders.length} escrita(s) direta(s) em tabelas críticas dentro de componentes de BROWSER:\n      ${offenders.map((o) => `${o.file}:${o.line} → ${o.table}.${o.op}`).join("\n      ")}\n      Um update bloqueado por RLS afeta 0 linhas SEM erro — a UI mostra sucesso e nada foi gravado ('gravo e não aparece'). Sem auditLog, sem is_exception, sem revalidatePath.`,
      "Migrar cada uma para server action que confirme linhas afetadas (.select) e trate 0 linhas como erro.");
  } else {
    report("ok", "Nenhum componente de browser escreve diretamente em tabelas críticas.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 8. PIPELINE DE MIGRAÇÃO — o runner é seguro?
// ════════════════════════════════════════════════════════════════════════════
function auditMigrationRunner() {
  section("8. PIPELINE DE MIGRAÇÃO — run-migrations.mjs");
  const p = join(ROOT, "scripts", "run-migrations.mjs");
  if (!existsSync(p)) { report("warn", "scripts/run-migrations.mjs não existe."); return; }
  const src = readFileSync(p, "utf8");

  if (/password:\s*["'][^"']+["']/.test(src)) {
    report("fail", "Password do Postgres HARDCODED no run-migrations.mjs (fica no histórico do git!).",
      "Mover para env (SUPABASE_DB_URL), remover do ficheiro e RODAR/trocar a password da base no dashboard do Supabase.");
  } else {
    report("ok", "Sem credenciais hardcoded no runner.");
  }

  if (!/_migrations/.test(src)) {
    report("fail", "O runner NÃO regista migrações aplicadas — re-executa TODAS em cada run. Migrações com UPDATE/DELETE (021, 023, 025) re-aplicam-se e podem REVERTER dados alterados entretanto. Fonte direta de 'valores que voltam atrás'.",
      "Usar tabela de controlo _migrations (só aplica pendentes).");
  } else {
    report("ok", "Runner usa tabela de controlo _migrations (só aplica pendentes).");
  }

  if (/seed\.sql/.test(src) && !/--seed/.test(src)) {
    report("fail", "O runner aplica seed.sql automaticamente — o próprio seed diz 'NÃO executar em produção'.",
      "Seed apenas com flag explícita --seed e bloqueado se a base já tiver dados.");
  } else if (/--seed/.test(src)) {
    report("ok", "Seed só corre com flag explícita e com guarda de produção.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 9. SERVICE WORKER / CACHE
// ════════════════════════════════════════════════════════════════════════════
function auditServiceWorker() {
  section("9. PWA / CACHE — código antigo retido no browser?");
  const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  if (!/stamp-sw/.test(pkg.scripts?.prebuild ?? "")) {
    report("fail", "O prebuild não carimba a versão do sw.js — a cache do PWA nunca é purgada em deploys.", "Repor 'node scripts/stamp-sw.mjs' no prebuild.");
  } else {
    report("ok", "sw.js é carimbado por deploy (prebuild) — cada deploy purga a cache antiga.");
  }

  if (/skipWaiting\(\)/.test(sw) && !/SKIP_WAITING/.test(sw.split("skipWaiting")[0])) {
    // skipWaiting só via mensagem = update manual
  }
  if (!/NÃO skipWaiting\(\) automático|skipWaiting\(\) automático/i.test(sw) && !/self\.skipWaiting\(\)\s*;?\s*\n?\s*\}\)\s*;?\s*self\.addEventListener\("install"/.test(sw)) {
    // heuristic only
  }
  if (/message.*SKIP_WAITING/s.test(sw)) {
    const pwaRegPath = join(ROOT, "src", "app", "(app)", "app", "_components", "pwa-register.tsx");
    const pwaReg = existsSync(pwaRegPath) ? readFileSync(pwaRegPath, "utf8") : "";
    if (/critical-action-tracker/.test(pwaReg)) {
      report("ok", "Atualização do PWA é automática em segundo plano (bloqueada durante ações críticas via critical-action-tracker), além do botão 'Atualizar' — telemóveis já não ficam presos em versões antigas.");
    } else {
      report("warn", "O novo service worker fica em 'waiting' até a pessoa tocar em 'Atualizar'. Colaboradoras que nunca tocam continuam a correr a APP ANTIGA — 'a alteração não aparece' no telemóvel delas. É uma decisão consciente (não recarregar a meio do ponto), mas explica parte das queixas.",
        "Manter, mas garantir que o aviso 'Nova versão disponível' é bem visível; ou forçar update quando a app está idle.");
    }
  }
  if (/Páginas HTML — sempre da rede/.test(sw)) {
    report("ok", "HTML nunca é servido da cache (sempre rede) — deploys novos aparecem ao recarregar.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("AUDITORIA DE REVERSÕES — Mó Limpezas");
  console.log(`Executada em ${new Date().toISOString()} | ${SKIP_DB ? "modo local (--skip-db)" : "modo completo"}`);

  auditGit();
  await auditDeployedVersion();
  auditMigrationRunner();
  auditServiceWorker();
  auditClientSideWrites();

  if (!SKIP_DB) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      report("fail", "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY em falta no .env.local — secções de base de dados saltadas.");
    } else {
      const admin = createClient(url, key, { auth: { persistSession: false } });
      await auditSchema(admin);
      await auditSeedContamination(admin);
      await auditClientes(admin);
      await auditContratos(admin);
      await auditCalendario(admin);
    }
  }

  // ── resumo ──
  const fails = findings.filter((f) => f.level === "fail");
  const warns = findings.filter((f) => f.level === "warn");
  console.log(`\n${"═".repeat(74)}\nRESUMO: ${fails.length} crítico(s) ❌ | ${warns.length} aviso(s) ⚠️ | ${findings.filter((f) => f.level === "ok").length} ok ✅`);
  if (fails.length) {
    console.log("\nCríticos por ordem de ataque:");
    fails.forEach((f, i) => console.log(`  ${i + 1}. [${f.section.split("—")[0].trim()}] ${f.msg.split("\n")[0]}`));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("Erro fatal na auditoria:", e); process.exit(2); });
