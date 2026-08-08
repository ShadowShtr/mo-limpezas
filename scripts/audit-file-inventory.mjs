/**
 * T17-A — Inventário e classificação de 100% dos ficheiros versionados.
 *
 * 🚨 ESTÁTICO E OFFLINE. Não liga ao Supabase, não lê `.env`, não faz rede,
 *    não executa nada do que analisa. Só lê ficheiros versionados e escreve
 *    um relatório.
 *
 * Uso:
 *   node scripts/audit-file-inventory.mjs
 *   node scripts/audit-file-inventory.mjs --output reports/file-classification.json
 *
 * ----------------------------------------------------------------------------
 *
 * Como classifica — e porque é conservador.
 *
 * A pergunta perigosa desta auditoria é "isto ainda é usado?". Uma busca
 * textual que não encontra consumidores NÃO prova que não existem: o Next.js
 * carrega `page.tsx`/`route.ts` por convenção, os crons são chamados por URL,
 * os scripts entram por `package.json`, e há imports dinâmicos.
 *
 * Por isso o classificador só marca `REMOVER` quando TODAS estas portas estão
 * fechadas ao mesmo tempo. Na dúvida devolve `STANDBY`, que é uma resposta
 * honesta e não custa nada. Um `REMOVER` errado custa um incidente.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

// ─── Ficheiros versionados ──────────────────────────────────────────────────

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean);
}

const FILES = trackedFiles();

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null; // binário ou ilegível
  }
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|yml|yaml|html|txt|example|gitignore|vercelignore)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const CONTENT = new Map();
for (const f of FILES) {
  if (!TEXT_EXT.test(f) && !/^[^.]+$/.test(path.basename(f))) continue;
  const c = read(f);
  if (c != null) CONTENT.set(f, c);
}

// ─── Grafo de imports ───────────────────────────────────────────────────────

/** Resolve um especificador para um caminho versionado, se possível. */
function resolveSpec(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(fromRel), spec);
  else return null; // pacote npm

  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
  ];
  for (const c of candidates) {
    const norm = c.split(path.sep).join("/");
    if (FILES.includes(norm)) return norm;
  }
  return null;
}

const IMPORTS = new Map();   // ficheiro → Set de ficheiros que importa
const CONSUMERS = new Map(); // ficheiro → Set de ficheiros que o importam

for (const f of FILES) CONSUMERS.set(f, new Set());

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

for (const [rel, src] of CONTENT) {
  if (!CODE_EXT.test(rel)) continue;
  const set = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const target = resolveSpec(rel, m[1]);
    if (target && target !== rel) {
      set.add(target);
      CONSUMERS.get(target)?.add(rel);
    }
  }
  IMPORTS.set(rel, set);
}

// ─── Referências não-import (npm, CI, config, docs) ─────────────────────────

const PKG = JSON.parse(read("package.json"));
const NPM_SCRIPTS = Object.values(PKG.scripts ?? {}).join(" \n ");
const CI = FILES.filter((f) => f.startsWith(".github/")).map((f) => CONTENT.get(f) ?? "").join("\n");
const VERCEL = CONTENT.get("vercel.json") ?? "";
const CONFIGS = ["next.config.ts", "tsconfig.json", "eslint.config.mjs", "postcss.config.mjs", "vitest.config.ts", "components.json"]
  .map((f) => CONTENT.get(f) ?? "").join("\n");

const DOCS = FILES.filter((f) => /\.md$/i.test(f)).map((f) => CONTENT.get(f) ?? "").join("\n");

function referencedIn(haystack, rel) {
  const base = path.posix.basename(rel);
  const noExt = base.replace(/\.[^.]+$/, "");
  return haystack.includes(rel) || haystack.includes(base)
    || (noExt.length > 4 && haystack.includes(noExt));
}

// ─── Convenções automáticas do Next.js ──────────────────────────────────────

const NEXT_CONVENTION = /(^|\/)(page|layout|loading|error|not-found|global-error|template|default|route|sitemap|robots|manifest|opengraph-image|icon|apple-icon)\.(ts|tsx|js|jsx)$/;

/**
 * Convenções que vivem na raiz do projecto ou de `src/`, e não dentro de
 * `app/`.
 *
 * `proxy.ts` é o nome que o **Next 16** deu ao antigo `middleware.ts` — é
 * carregado pelo framework sem ninguém o importar. A primeira versão deste
 * classificador procurava `middleware` só dentro de `src/app/` e marcou o
 * `src/proxy.ts` como órfão. Era falso: é o ficheiro que protege TODAS as
 * rotas por role, e "remover" seria abrir a aplicação inteira.
 *
 * Fica aqui como aviso: a análise estática não conhece as convenções do
 * framework a menos que lhas ensinem, e cada versão maior traz nomes novos.
 */
const ROOT_CONVENTION = /^(src\/)?(proxy|middleware|instrumentation|instrumentation-client)\.(ts|tsx|js|mjs)$/;

function isNextConvention(rel) {
  if (ROOT_CONVENTION.test(rel)) return true;
  return rel.startsWith("src/app/") && NEXT_CONVENTION.test(rel);
}

// Nota: um ficheiro de `scripts/` é um ponto de entrada de linha de comandos.
// Não ter quem o importe é o normal, não um sinal de código morto — por isso a
// classificação de `category === "script"` olha para o que ele CONSEGUE FAZER
// (ver `scriptRisk`) e não para quantos consumidores tem.

// ─── Sinais por ficheiro ────────────────────────────────────────────────────

const SIGNALS = {
  supabase: /createAdminClient|createClient|@supabase\/|supabase\./,
  env: /process\.env/,
  network: /\bfetch\s*\(|axios|XMLHttpRequest|WebSocket/,
  serverAction: /^\s*["']use server["']/m,
  clientComponent: /^\s*["']use client["']/m,
  serviceRole: /SERVICE_ROLE|service_role|sb_secret_|SUPABASE_SECRET/,
  write: /\.(insert|update|upsert|delete)\s*\(/,
  sqlWrite: /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i,
  todo: /\b(TODO|FIXME|HACK|XXX)\b/,
  tsIgnore: /@ts-ignore|@ts-expect-error/,
  eslintDisable: /eslint-disable/,
  anyType: /:\s*any\b|\bas any\b|<any>/,
  unknownCast: /as unknown as/,
  consoleLog: /console\.(log|debug|info)\s*\(/,
  consoleErr: /console\.(error|warn)\s*\(/,
  debugger: /\bdebugger\b/,
  selectStar: /\.select\(\s*["']\*["']\s*\)/,
  ignoredError: /const\s*\{\s*data:\s*\w+\s*\}\s*=\s*(?:(?:await\s+)?(?:admin|supabase)\b|[^;=]{0,60}\?\s*\n?\s*await\s+(?:admin|supabase)\b)/,
  emptyCatch: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  fallbackZero: /\?\?\s*0\b/,
  fallbackArray: /\?\?\s*\[\]/,
  revalidatePath: /revalidatePath\s*\(/,
  realtime: /postgres_changes|\.channel\s*\(/,
  dynamicImport: /import\s*\(/,
};

function countMatches(src, re) {
  const m = src.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

// ─── Categoria estrutural ───────────────────────────────────────────────────

function categoryOf(rel) {
  if (rel.startsWith("src/__tests__/")) return "test";
  if (rel.startsWith("src/domain/")) return "domain";
  if (rel.startsWith("src/app/api/")) return "api-route";
  if (rel.startsWith("src/app/actions/") || /_actions\//.test(rel)) return "server-action";
  if (rel.startsWith("src/app/")) return "route-ui";
  if (rel.startsWith("src/components/")) return "component";
  if (rel.startsWith("src/lib/")) return "lib";
  if (rel.startsWith("src/types/")) return "types";
  if (rel.startsWith("src/hooks/")) return "hook";
  if (rel.startsWith("src/")) return "src-other";
  if (rel.startsWith("supabase/migrations/")) return "migration";
  if (rel.startsWith("supabase/frozen/")) return "sql-frozen";
  if (rel.startsWith("supabase/")) return "supabase-other";
  if (rel.startsWith("scripts/")) return "script";
  if (rel.startsWith("docs/")) return "doc";
  if (rel.startsWith("planning/")) return "planning";
  if (rel.startsWith("public/")) return "asset";
  if (rel.startsWith(".github/")) return "ci";
  if (rel.startsWith("reports/")) return "report";
  if (/^(package|package-lock|tsconfig|next\.config|eslint\.config|postcss\.config|vitest\.config|components|vercel)\./.test(rel)) return "config";
  if (/^\.(env\.example|gitignore|vercelignore)$/.test(rel)) return "config";
  if (/\.md$/i.test(rel)) return "doc";
  return "other";
}

// ─── Classificação de scripts ───────────────────────────────────────────────

/**
 * **Usa** a chave administrativa, por oposição a apenas mencioná-la.
 *
 * A distinção não é cosmética: `scan-secrets.mjs`, `audit-security.ts` e
 * `check-env.ts` existem precisamente para PROCURAR a chave, e a primeira
 * versão desta regra marcou-os como perigosos por conterem a palavra. Um
 * scanner de segurança classificado como ameaça é o tipo de ruído que faz um
 * inventário deixar de ser lido.
 *
 * O que conta é a chave a ser LIDA de `process.env` e passada a um cliente, ou
 * atribuída a uma variável.
 */
const USES_SERVICE_ROLE =
  /process\.env\.SUPABASE_SERVICE_ROLE_KEY|env\.SUPABASE_SERVICE_ROLE_KEY|createAdminClient\s*\(|SUPABASE_SECRET_KEY/;

function scriptRisk(rel, src) {
  if (!rel.startsWith("scripts/")) return null;

  // Primeiro o que é comprovadamente inofensivo, senão as menções às flags
  // perigosas dentro de `assertNoWriteFlags` — que existe para as RECUSAR —
  // fazem o comparador parecer capaz de escrever. Foi o que aconteceu na
  // primeira versão com os três `compare-*-compat.ts`.
  const semBase = !SIGNALS.supabase.test(src) && !/SUPABASE_DB_URL|SERVICE_ROLE/i.test(src);
  if (/assertNoWriteFlags/.test(src) && semBase) return "SAFE_OFFLINE";
  if (semBase && !SIGNALS.write.test(src)) return "SAFE_OFFLINE";

  if (USES_SERVICE_ROLE.test(src)) {
    // Chave administrativa + escrita é a combinação que apagou dados no
    // passado. Chave administrativa só para ler é grave, mas menos.
    return SIGNALS.write.test(src) || /\bDROP\b|\bTRUNCATE\b|deleteUser|admin\.auth/i.test(src)
      ? "PRODUCTION_DANGEROUS"
      : "ADMIN_READ";
  }
  if (/--apply|--confirm-production|--execute|--commit\b/.test(src)) return "WRITE_CAPABLE";
  if (SIGNALS.write.test(src) || /\bDROP\b|\bTRUNCATE\b/i.test(src)) return "WRITE_CAPABLE";
  if (SIGNALS.supabase.test(src) || /SUPABASE_DB_URL/i.test(src)) return "READ_ONLY";
  return "SAFE_OFFLINE";
}

// ─── Decisões manuais ───────────────────────────────────────────────────────

/**
 * Onde a análise estática não decide, decide uma pessoa — e a razão fica
 * escrita aqui, não escondida num palpite do classificador.
 *
 * Cada entrada é uma afirmação verificável. Se alguma deixar de ser verdade, o
 * teste `t17-inventory-guard` obriga a regenerar o inventário e a diferença
 * aparece no diff.
 */
const MANUAL = {
  // O nome contém U+F03A — o carácter que o Windows usa no lugar de `:`, que é
  // ilegal em NTFS. Descodificado, o nome do ficheiro é o caminho
  // `C:\Temp\mo-limpezas-dev.log`: alguém escreveu `> C:\Temp\...` numa shell
  // que tratou o caminho como nome relativo, e o resultado foi commitado.
  "C\uF03ATempmo-limpezas-dev.log": {
    status: "REMOVER",
    confidence: "alta",
    reason:
      "o nome do ficheiro é um caminho do Windows capturado por engano num "
      + "redireccionamento de saída. Não é código, não é documentação, tem zero "
      + "referências e o conteúdo é um log de desenvolvimento de uma sessão antiga.",
    action: "T17-B: remover",
  },
  "src/app/actions/whatsapp.ts": {
    status: "STANDBY",
    confidence: "alta",
    reason:
      "implementação da Meta Cloud API, deliberadamente NÃO activa: o produto usa links "
      + "wa.me construídos no cliente (client-notifications-modal.tsx). Registado como "
      + "decisão no CLAUDE.md, não é esquecimento.",
    action: "decidir com o dono: activar ou remover",
  },
  "src/lib/bank-import/xlsx.ts": {
    status: "STANDBY",
    confidence: "alta",
    reason:
      "parser parqueado de propósito — `bank-import/index.ts` diz em comentário que só "
      + "CSV é aceite nesta fase e que xlsx/pdf ficam no repo sem serem chamados.",
    action: "manter até a fase que aceitar XLSX",
  },
  "src/lib/bank-import/pdf.ts": {
    status: "STANDBY",
    confidence: "alta",
    reason: "mesma decisão do xlsx.ts — parqueado, documentado no index.ts.",
    action: "manter até a fase que aceitar PDF",
  },
  "src/proxy.ts": {
    status: "MANTER",
    confidence: "alta",
    reason:
      "convenção do Next 16 (o antigo `middleware.ts`). Protege TODAS as rotas por role. "
      + "Carregado pelo framework, sem importadores — a ausência de consumidores é o "
      + "esperado, não um sinal de código morto.",
    action: "nenhuma",
  },
};

// ─── Classificador principal ────────────────────────────────────────────────

function classify(rel) {
  const src = CONTENT.get(rel) ?? "";
  const category = categoryOf(rel);
  const consumers = [...(CONSUMERS.get(rel) ?? [])];
  const isCode = CODE_EXT.test(rel);

  const signals = {};
  for (const [k, re] of Object.entries(SIGNALS)) {
    const n = countMatches(src, re);
    if (n > 0) signals[k] = n;
  }

  const auto = isNextConvention(rel);
  const inNpm = referencedIn(NPM_SCRIPTS, rel);
  const inCi = referencedIn(CI, rel);
  const inVercel = referencedIn(VERCEL, rel);
  const inConfig = referencedIn(CONFIGS, rel);
  const inDocs = referencedIn(DOCS, rel);

  const risks = [];
  if (signals.serviceRole) risks.push("service-role");
  if (signals.ignoredError) risks.push(`erro-de-query-ignorado(${signals.ignoredError})`);
  if (signals.emptyCatch) risks.push(`catch-vazio(${signals.emptyCatch})`);
  if (signals.anyType) risks.push(`any(${signals.anyType})`);
  if (signals.tsIgnore) risks.push(`ts-ignore(${signals.tsIgnore})`);
  if (signals.selectStar) risks.push(`select-*(${signals.selectStar})`);
  if (signals.debugger) risks.push("debugger");
  if (signals.todo) risks.push(`todo(${signals.todo})`);

  const sideEffects = [];
  if (signals.supabase) sideEffects.push("supabase");
  if (signals.env) sideEffects.push("env");
  if (signals.network) sideEffects.push("network");
  if (signals.write) sideEffects.push("write");
  if (signals.revalidatePath) sideEffects.push(`revalidatePath(${signals.revalidatePath})`);
  if (signals.realtime) sideEffects.push("realtime");

  // ── Estado e acção ──
  let status = "MANTER";
  let confidence = "alta";
  let reason = "";
  let action = "nenhuma";

  const reachable = auto || inNpm || inCi || inVercel || inConfig || consumers.length > 0;

  if (category === "migration") {
    status = "MANTER";
    reason = "migration versionada — histórico do schema, nunca se apaga";
  } else if (category === "sql-frozen") {
    status = "STANDBY";
    reason = "SQL congelado, não aplicado — depende de base descartável";
  } else if (category === "planning") {
    status = "ARQUIVAR";
    confidence = "média";
    reason = "documentação de planeamento anterior ao produto actual";
    action = "avaliar movimento para docs/historico/ na T17-B";
  } else if (category === "doc") {
    status = "MANTER";
    reason = "documentação";
  } else if (category === "test") {
    status = "MANTER";
    reason = "suite de testes — corre por convenção do vitest";
  } else if (category === "config" || category === "ci" || category === "report") {
    status = "MANTER";
    reason = "configuração/infra";
  } else if (category === "asset") {
    status = reachable || inDocs ? "MANTER" : "STANDBY";
    confidence = reachable ? "alta" : "baixa";
    reason = reachable ? "asset referenciado" : "asset sem referência textual — pode ser carregado por caminho dinâmico";
  } else if (category === "script") {
    // Um script é um ponto de entrada: não ter importadores é o normal.
    // A pergunta útil é o que ele consegue fazer e se ainda serve.
    const risk = scriptRisk(rel, src);
    if (risk === "PRODUCTION_DANGEROUS") {
      status = "STANDBY";
      confidence = "alta";
      reason = "usa a chave administrativa E escreve/apaga — capaz de estragar uma base real";
      action = "T17-B: decidir entre arquivar, exigir flag explícita, ou remover";
    } else if (risk === "ADMIN_READ") {
      status = "MANTER";
      confidence = "média";
      reason = "usa a chave administrativa, mas só para ler";
      action = "manter fora de qualquer execução automática";
    } else if (risk === "WRITE_CAPABLE") {
      status = "STANDBY";
      confidence = "média";
      reason = "capaz de escrever na base";
      action = "T17-B: confirmar se ainda é preciso";
    } else {
      status = "MANTER";
      reason = risk === "SAFE_OFFLINE"
        ? "ferramenta offline, sem acesso à base"
        : "script de leitura";
    }
  } else if (isCode && !reachable) {
    status = "STANDBY";
    confidence = inDocs ? "média" : "baixa";
    reason = inDocs
      ? "sem consumidor no código, mas referido na documentação"
      : "sem consumidor encontrado por análise estática";
    action = "T17-B: provar ausência de import dinâmico/convenção antes de remover";
  } else if (isCode) {
    // Alcançável. Diz-se PORQUÊ — uma classificação sem razão escrita é um
    // palpite, e o teste do inventário recusa-a.
    const vias = [
      auto && "convenção do Next",
      consumers.length > 0 && `${consumers.length} consumidor(es)`,
      inNpm && "script npm",
      inCi && "CI",
      inVercel && "vercel.json",
      inConfig && "configuração",
    ].filter(Boolean);
    reason = `em uso: ${vias.join(", ")}`;
  } else {
    reason = reason || `ficheiro de ${category}`;
  }

  // ── Refinamentos que se sobrepõem à regra geral ──

  if (/legacy-(formulas|reports|dashboard|recurrence)\.ts$/.test(rel)) {
    status = "STANDBY";
    confidence = "alta";
    reason = "réplica deliberada das fórmulas antigas, só para comparação";
    action = "remover depois de os ecrãs consumirem o modelo canónico";
  }

  if (category === "server-action" && signals.write) {
    action = action === "nenhuma" ? "auditar atomicidade (T12/T13)" : action;
  }

  // ── Decisão manual tem a última palavra ──
  const manual = MANUAL[rel];
  if (manual) {
    status = manual.status;
    confidence = manual.confidence;
    reason = manual.reason;
    action = manual.action;
  }

  const entry = {
    path: rel,
    category,
    status,
    confidence,
    consumers: consumers.length,
    consumerSample: consumers.slice(0, 3),
    autoLoaded: auto,
    referencedBy: [
      inNpm && "npm", inCi && "ci", inVercel && "vercel",
      inConfig && "config", inDocs && "docs",
    ].filter(Boolean),
    sideEffects,
    risks,
    signals,
    action,
    reason,
    manualDecision: manual != null,
  };

  if (category === "script") entry.scriptRisk = scriptRisk(rel, src);

  return entry;
}

const ENTRIES = FILES.map(classify);

// ─── Saída ──────────────────────────────────────────────────────────────────

function tally(key) {
  const out = {};
  for (const e of ENTRIES) out[e[key]] = (out[e[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

const report = {
  generatedBy: "scripts/audit-file-inventory.mjs",
  totalFiles: ENTRIES.length,
  byStatus: tally("status"),
  byCategory: tally("category"),
  byConfidence: tally("confidence"),
  scriptRisk: Object.fromEntries(
    Object.entries(
      ENTRIES.filter((e) => e.scriptRisk).reduce((acc, e) => {
        acc[e.scriptRisk] = (acc[e.scriptRisk] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  ),
  files: ENTRIES.sort((a, b) => a.path.localeCompare(b.path)),
};

const outArg = process.argv.indexOf("--output");
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;
const json = `${JSON.stringify(report, null, 2)}\n`;

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");
  console.error(`✔ inventário gravado em ${outPath}`);
} else {
  process.stdout.write(json);
}

console.error("");
console.error(`Ficheiros versionados: ${report.totalFiles}`);
console.error("Por estado:");
for (const [k, v] of Object.entries(report.byStatus)) console.error(`  ${k.padEnd(14, ".")} ${v}`);
console.error("Por categoria:");
for (const [k, v] of Object.entries(report.byCategory)) console.error(`  ${k.padEnd(18, ".")} ${v}`);
if (Object.keys(report.scriptRisk).length > 0) {
  console.error("Risco dos scripts:");
  for (const [k, v] of Object.entries(report.scriptRisk)) console.error(`  ${k.padEnd(24, ".")} ${v}`);
}
console.error("");
