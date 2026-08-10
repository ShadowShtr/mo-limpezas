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

/**
 * Existe algum `import(...)` cujo especificador NÃO é uma string literal?
 *
 * Se existir, o grafo de imports acima está incompleto por construção: não há
 * como saber estaticamente para onde um especificador construído em tempo de
 * execução aponta. É a terceira porta de `deadCodeDoors`, e é global — basta um
 * no repositório para que "sem importadores" deixe de significar "sem
 * consumidores" para qualquer módulo.
 */
const UNRESOLVED_DYNAMIC_IMPORT = [...CONTENT].some(
  ([rel, src]) => CODE_EXT.test(rel) && /\bimport\s*\(\s*(?!["'])/.test(src),
);

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

/**
 * AS TRÊS PORTAS — helper reutilizável (T17-B1).
 *
 * A T17-A produziu três falsos positivos, todos do mesmo feitio: uma busca
 * textual não encontrou consumidores e o classificador concluiu "morto". Não
 * encontrar consumidores não prova que não existem. Há três caminhos que a
 * busca por imports **não vê**:
 *
 *   1. **convenção do framework** — o Next carrega `page`/`route`/`proxy` pelo
 *      NOME. `src/proxy.ts` protege todas as rotas por role e não tem um único
 *      importador, por desenho;
 *   2. **entrada de linha de comandos** — `package.json`, CI, `vercel.json`, ou
 *      execução manual. Um ficheiro de `scripts/` não ter importadores é o
 *      normal, não um sinal;
 *   3. **import dinâmico** — `import(...)`/`require(...)` com especificador
 *      construído em tempo de execução, que o grafo estático não resolve.
 *
 * Enquanto uma destas portas não estiver PROVADAMENTE fechada, o veredicto é
 * `STANDBY`. `STANDBY` é uma resposta honesta e não custa nada; um `REMOVER`
 * errado custa um incidente.
 */
function deadCodeDoors(rel, src, ctx) {
  const doors = {
    frameworkConvention: isNextConvention(rel),
    cliEntrypoint: rel.startsWith("scripts/") || ctx.inNpm || ctx.inCi || ctx.inVercel || ctx.inConfig,
    // Conservador de propósito: qualquer `import(` não resolvido no ficheiro
    // OU em quem quer que seja mantém a porta aberta a nível global — não se
    // consegue provar estaticamente para onde um especificador dinâmico aponta.
    dynamicImport: /import\s*\(\s*[^"')]/.test(src) || UNRESOLVED_DYNAMIC_IMPORT,
  };
  doors.allClosed = !doors.frameworkConvention && !doors.cliEntrypoint && !doors.dynamicImport;
  return doors;
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
  // Antes de `scripts/`: um script arquivado continua a ser código versionado,
  // mas deixou de fazer parte da superfície operacional. Selado com uma recusa
  // sem escapatória na T17-B2 — ver docs/SCRIPTS-SAFETY-MATRIX.md.
  if (rel.startsWith("scripts/historico/")) return "script-historico";
  if (rel.startsWith("scripts/")) return "script";
  // Antes de `docs/`: o arquivo histórico é documentação, mas não é
  // documentação VIGENTE, e a distinção tem de sobreviver no inventário.
  // Movido de `planning/` na T17-B1 — ver docs/historico/planning/README-ARQUIVO.md
  if (rel.startsWith("docs/historico/")) return "doc-historico";
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
 * Remove **literais de expressão regular** do código.
 *
 * Este é o remédio de raiz para a família de falsos positivos que a T17-A
 * registou três vezes e a T17-B1 apanhou mais duas: um analisador estático que
 * procura padrões no código acaba, inevitavelmente, a encontrá-los **em si
 * próprio** — porque as regras que aplica são texto no seu próprio corpo. Este
 * ficheiro chegou a classificar-se a si mesmo como `PRODUCTION_DANGEROUS` por
 * conter `SERVICE_ROLE`, `DROP`, `TRUNCATE` e `/rest/v1/` dentro das suas
 * próprias expressões.
 *
 * Corrigir caso a caso era jogar à apanhada: cada regra nova voltava a
 * disparar. Tirar os literais de regex resolve a classe inteira de uma vez —
 * uma regra escrita **é** uma menção, nunca um uso.
 *
 * Os comentários são tratados conforme a PERGUNTA, através de
 * `{ dropComments }` — e a distinção não é arbitrária:
 *
 * - **capacidade** ("consegue tocar na base?") tem de ser provada por código a
 *   correr. Um comentário que descreve uma chamada REST não faz nenhuma. Aqui
 *   os comentários saem (`dropComments: true`);
 * - **interface de linha de comandos** ("tem `--apply`?") está declarada no
 *   cabeçalho de uso, em comentário. Removê-los produziu o erro simétrico e
 *   mais perigoso: `run-migrations.mjs` caiu de `WRITE_CAPABLE` para
 *   `READ_ONLY` porque as flags que o tornam capaz de escrever só aparecem
 *   ali. Aqui os comentários ficam.
 *
 * Os literais de string ficam sempre: `.from("services")` é uso a sério.
 */
function stripNonCode(src, { dropComments = false } = {}) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Contexto de operador: a seguir a estes, um `/` inicia um literal de regex,
  // não uma divisão.
  const opBefore = /[=(,:;[!&|?{}+\-*%~^]|\breturn\b|\btypeof\b|\bcase\b/;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {                       // comentário de linha
      while (i < n && src[i] !== "\n") { if (!dropComments) out += src[i]; i++; }
      continue;
    }
    if (c === "/" && next === "*") {                       // comentário de bloco
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (!dropComments) out += src[i]; i++; }
      if (!dropComments) out += "*/";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {              // string: preservada
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/") {                                        // possível regex
      const prev = out.replace(/\s+$/, "").slice(-8);
      if (opBefore.test(prev.slice(-1)) || opBefore.test(prev)) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) { closed = true; j++; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[gimsuyd]/.test(src[j])) j++;
          i = j;                                            // literal descartado
          continue;
        }
      }
    }
    out += c; i++;
  }
  return out;
}

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

/**
 * O script CONSTRÓI mesmo um cliente de base de dados?
 *
 * Quarto falso positivo da mesma família (T17-B1). O próprio
 * `audit-file-inventory.mjs` aparecia como `PRODUCTION_DANGEROUS` no inventário
 * da T17-A — o relatório dizia 15 enquanto o documento dizia 14 e nomeava 14
 * scripts de dados. A causa: este ficheiro contém as palavras `SERVICE_ROLE`,
 * `DROP` e `TRUNCATE` **dentro das suas próprias expressões de detecção**. Um
 * auditor estático classificado como ameaça pelo próprio critério que aplica.
 *
 * A correcção é a mesma lição já aprendida três vezes — **mencionar ≠ usar** —
 * levada ao fim: um script que nunca constrói um cliente, nunca importa o SDK e
 * nunca abre uma ligação **não consegue tocar na base**, independentemente das
 * palavras que tenha no corpo. Esta pergunta vem primeiro que todas as outras.
 */
const CONSTRUCTS_DB_CLIENT =
  /createClient\s*\(|createAdminClient\s*\(|openAdminDb\s*\(|from\s+["']@supabase\/|require\s*\(\s*["']@supabase\/|new\s+(?:Client|Pool)\s*\(|from\s+["']pg["']/;

/**
 * Passa pelas guardas comuns da T17-B2?
 *
 * Esta pergunta teve de ser acrescentada no momento em que os scripts foram
 * migrados — e a razão é instrutiva. Ao substituir `createClient(...)` por
 * `openAdminDb(...)`, os quinze `PRODUCTION_DANGEROUS` desapareceram do
 * inventário de uma vez: passaram todos a `SAFE_OFFLINE`, porque nenhum
 * continha já `process.env.SUPABASE_SERVICE_ROLE_KEY` nem construía um cliente
 * que o classificador reconhecesse.
 *
 * Continuavam, evidentemente, a escrever na base com a chave administrativa.
 * Só a tinham deixado de pedir directamente.
 *
 * É o mesmo falso "seguro" que a T17-B1 apanhou em `import-predios.mjs`, agora
 * causado pela própria correcção. A capacidade não mudou — mudou a forma de a
 * exercer, e um detector que só conhece a forma antiga dá luz verde à nova.
 */
const USES_GUARDED_ADMIN = /openAdminDb\s*\(/;
const GUARDED_WRITES = /writes:\s*true|\bdb\.(write|restWrite)\s*\(/;

/**
 * O SDK não é a única porta de entrada.
 *
 * A primeira versão de `CONSTRUCTS_DB_CLIENT` assumia que sim, e baixou
 * `backup-now.mjs` e `import-predios.mjs` para `SAFE_OFFLINE`. Ambos chegam à
 * base por **HTTP directo à API REST** (`${SUPABASE_URL}/rest/v1/…` com a chave
 * administrativa no cabeçalho), sem importar uma única linha do SDK —
 * `import-predios.mjs --apply` escreve mesmo em `building_cards`, e foi assim
 * que os 146 prédios reais entraram em produção.
 *
 * Uma regra de segurança que só reconhece o caminho conhecido dá um falso
 * "seguro" — que é pior do que não ter regra nenhuma.
 */
const CALLS_REST_API = /\/rest\/v1\/|\/auth\/v1\/admin|\/storage\/v1\//;

function scriptRisk(rel, raw) {
  if (!rel.startsWith("scripts/")) return null;

  // Duas vistas do mesmo ficheiro, para duas perguntas diferentes.
  // `code`: o que o script FAZ — sem comentários nem literais de regex.
  // `text`: o que o script OFERECE como interface — comentários de uso mantidos.
  const src = stripNonCode(raw, { dropComments: true });
  const text = stripNonCode(raw);

  // Porta zero: sem cliente construído, sem cadeia de ligação lida do ambiente
  // e sem chamada à API REST, o script não consegue tocar na base — por mais
  // nomes de chave e verbos SQL que mencione.
  const usesDbUrl = /(?:process\.)?env\.SUPABASE_DB_URL|env\[["']SUPABASE_DB_URL["']\]/.test(src);
  if (!CONSTRUCTS_DB_CLIENT.test(src) && !usesDbUrl && !CALLS_REST_API.test(src)) return "SAFE_OFFLINE";

  // A partir daqui está PROVADO que o script consegue chegar a uma base. Os
  // antigos atalhos `semBase` foram removidos: só sabiam reconhecer o SDK do
  // Supabase e deixavam passar por "offline" um script que fala Postgres
  // directo. Foi o que aconteceu a `verify-profile-guards.mjs`, cujo próprio
  // cabeçalho diz "Este script ESCREVE" — liga por `pg` e executa SQL, sem um
  // único `.insert(`. Porta zero torna esses atalhos desnecessários.

  // Há três maneiras de escrever, e reconhecer só uma dá um falso "seguro":
  //   SDK   → `.insert(` / `.update(` / …
  //   HTTP  → método que não é GET contra `/rest/v1/`
  //   SQL   → verbo de escrita numa query enviada por `pg`
  const writesViaRest =
    CALLS_REST_API.test(src) && /method:\s*["'](POST|PATCH|PUT|DELETE)["']/i.test(src);
  // Sem `/i`, de propósito. Com a flag, `UPDATE\s+\w` apanhava prosa
  // portuguesa — "update manual", "update quando a app está idle" — e promovia
  // `audit-reversoes.mjs`, que só LÊ, a `PRODUCTION_DANGEROUS`. O SQL destes
  // scripts é escrito em maiúsculas; a linguagem natural à volta não é.
  const writesViaSql =
    /\b(INSERT\s+INTO|UPDATE\s+(?:public\.|"|\w+\s+SET)|DELETE\s+FROM|DROP\s+(?:TABLE|VIEW|FUNCTION|TRIGGER|POLICY|SCHEMA)|TRUNCATE\s+|ALTER\s+TABLE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|TRIGGER|POLICY))/.test(src);
  const writes =
    SIGNALS.write.test(src) || writesViaRest || writesViaSql
    || /deleteUser|admin\.auth\.(?:create|delete|update)/i.test(src);

  // Chave administrativa **através das guardas comuns**: o alvo é declarado e
  // confrontado, dry-run é o omisso, produção é recusada e `company_id` é
  // obrigatório. Continua a ser poder a sério — por isso tem classe própria e
  // não se confunde com uma ferramenta offline — mas já não é a mesma coisa
  // que a chave crua.
  if (USES_GUARDED_ADMIN.test(src)) {
    return GUARDED_WRITES.test(src) ? "ADMIN_GUARDED_WRITE" : "ADMIN_READ";
  }

  if (USES_SERVICE_ROLE.test(src)) {
    // Chave administrativa crua + escrita é a combinação que apagou dados no
    // passado. Chave administrativa só para ler é grave, mas menos.
    return writes ? "PRODUCTION_DANGEROUS" : "ADMIN_READ";
  }
  if (writes) return "WRITE_CAPABLE";
  // Flags declaradas no cabeçalho de uso contam — ver `stripNonCode`.
  if (/--apply|--confirm-production|--execute|--commit\b/.test(text)) return "WRITE_CAPABLE";
  return "READ_ONLY";
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

/**
 * Resíduo de redireccionamento de shell do Windows (T17-B1).
 *
 * `:` é ilegal num nome de ficheiro NTFS, e o Windows substitui-o por **U+F03A**
 * na área de uso privado do Unicode. Quando alguém escreve `> C:\Temp\x.log`
 * numa shell que trata o caminho como nome relativo, nasce um ficheiro cujo
 * NOME é o caminho inteiro — e se ninguém reparar, é commitado.
 *
 * A T17-B1 removeu um caso destes (`C:\Temp\mo-limpezas-dev.log`). Esta regra
 * substitui a entrada manual que lá estava: em vez de fixar o nome de um
 * ficheiro que já não existe — o que congelaria o lixo no inventário — apanha o
 * **padrão**, para que um resíduo novo do mesmo tipo seja marcado sozinho.
 */
const WINDOWS_PATH_RESIDUE = /[\uE000-\uF8FF]/;

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
  const doors = deadCodeDoors(rel, src, { inNpm, inCi, inVercel, inConfig });

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
  } else if (category === "script-historico") {
    status = "MANTER";
    reason =
      "script arquivado na T17-B2: preservado para auditoria e para explicar como "
      + "os dados chegaram à base, selado com uma recusa sem escapatória que o impede "
      + "de correr. Já não é superfície operacional";
    action = "não desbloquear: se o que faz voltar a ser preciso, escrever ferramenta nova com as guardas actuais";
  } else if (category === "doc-historico") {
    status = "MANTER";
    reason =
      "arquivo histórico preservado em docs/historico/ — explica o porquê das "
      + "decisões, NÃO descreve o sistema actual e nunca é instrução de implementação";
    action = "não reescrever: histórico não se corrige, corrige-se o documento vigente";
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
      reason = "usa a chave administrativa crua E escreve/apaga — capaz de estragar uma base real";
      action = "endurecer com scripts/lib/admin-db.mjs (T17-B2), arquivar, ou remover";
    } else if (risk === "ADMIN_GUARDED_WRITE") {
      status = "MANTER";
      confidence = "alta";
      reason =
        "escreve com a chave administrativa, mas através das guardas comuns da T17-B2: "
        + "alvo declarado e confrontado, dry-run por omissão, produção recusada sem "
        + "autorização explícita, company_id obrigatório";
      action = "manter fora de qualquer execução automática";
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
    // Sem consumidores. NÃO é o mesmo que morto — ver `deadCodeDoors`.
    status = "STANDBY";
    confidence = inDocs ? "média" : "baixa";
    reason = inDocs
      ? "sem consumidor no código, mas referido na documentação"
      : "sem consumidor encontrado por análise estática";
    action = doors.allClosed
      ? "as três portas estão fechadas — candidato a REMOVER, mas exige decisão manual e prova caso a caso"
      : `porta(s) ainda abertas (${[
        doors.frameworkConvention && "convenção do framework",
        doors.cliEntrypoint && "entrada de CLI",
        doors.dynamicImport && "import dinâmico não resolúvel",
      ].filter(Boolean).join(", ")}) — não remover`;
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

  // Resíduo de redireccionamento do Windows: o nome do ficheiro é um caminho.
  // Sobrepõe-se a tudo — nenhum ficheiro destes é código, documentação ou
  // configuração, e nenhum tem consumidores.
  if (WINDOWS_PATH_RESIDUE.test(rel)) {
    status = "REMOVER";
    confidence = "alta";
    reason =
      "o nome do ficheiro contém um carácter da área de uso privado do Unicode "
      + "(U+E000–U+F8FF), o que o Windows usa para caracteres ilegais em NTFS como "
      + "`:` — é um caminho capturado por engano num redireccionamento de saída, não "
      + "um ficheiro que alguém tenha decidido criar.";
    action = "remover, depois de confirmar zero referências e conteúdo sem valor";
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
    // As três portas, explícitas no relatório: um `REMOVER` futuro tem de as
    // mostrar todas fechadas, e quem ler o inventário vê porquê sem reler o
    // classificador.
    deadCodeDoors: isCode ? doors : undefined,
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
