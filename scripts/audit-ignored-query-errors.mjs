/**
 * T17-B1 — Inventário determinístico dos erros de consulta ignorados.
 *
 * 🚨 ESTÁTICO E OFFLINE. Não liga ao Supabase, não lê `.env`, não faz rede, não
 *    executa nada do que analisa. Lê ficheiros versionados e escreve um JSON.
 *
 * Uso:
 *   node scripts/audit-ignored-query-errors.mjs
 *   node scripts/audit-ignored-query-errors.mjs --output reports/ignored-query-errors.json
 *
 * ----------------------------------------------------------------------------
 *
 * O padrão que procura:
 *
 *     const { data: x } = await admin.from("tabela")...
 *
 * O `error` não é desestruturado. Quando a consulta falha, `data` vem `null`, o
 * `?? []` a seguir transforma isso numa lista vazia, e o ecrã mostra zero com ar
 * de número certo. Não há excepção, não há log, não há sinal nenhum.
 *
 * É o mesmo mecanismo pelo qual uma regressão financeira consegue passar
 * despercebida: a diferença entre "não há pagamentos" e "a consulta dos
 * pagamentos falhou" desaparece antes de chegar ao ecrã.
 *
 * ----------------------------------------------------------------------------
 *
 * ⚠️ Este relatório NÃO corrige nada e NÃO contém dados reais: só caminhos,
 *    números de linha, nomes de tabela e nomes de função lidos do código. Zero
 *    PII, zero credenciais, zero mensagens vindas da base.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
}

// A MESMA expressão do classificador da T17-A (`audit-file-inventory.mjs`,
// SIGNALS.ignoredError). Divergir daqui faria os dois relatórios contarem
// coisas diferentes com o mesmo nome, que é pior do que não ter nenhum.
const IGNORED_ERROR = /const\s*\{\s*data:\s*(\w+)\s*\}\s*=\s*(?:(?:await\s+)?(?:admin|supabase)\b|[^;=]{0,60}\?\s*\n?\s*await\s+(?:admin|supabase)\b)/g;

/**
 * Nem tudo o que devolve `{ data }` é uma consulta.
 *
 * `admin.storage.from(bucket).getPublicUrl(path)` é **síncrono** e não tem
 * `error` nenhum para desestruturar — devolve `{ data: { publicUrl } }` e
 * pronto. A expressão acima apanhava-o na mesma, porque casa com `= admin` sem
 * exigir `await`, e o resultado era um "erro ignorado" que ninguém pode
 * corrigir: não há erro.
 *
 * Mais um caso da armadilha de sempre — desta vez a forma parece a de uma
 * consulta sem o ser.
 */
const NOT_A_QUERY = /\.storage\b|getPublicUrl\s*\(/;

// ─── Superfícies ────────────────────────────────────────────────────────────

/** Tabelas onde uma consulta silenciosamente vazia vira um número em euros. */
const FINANCIAL_TABLES = new Set([
  "invoices", "invoice_items", "fixed_variable_payments", "cash_flow_entries",
  "payroll_records", "contracts", "bank_accounts", "bank_transactions",
  "bank_statement_imports", "bank_reconciliation_matches", "service_price_audit",
]);

const FINANCIAL_PATH = /(invoices|payments|cash-flow|payroll|daily-billing|financeiro|cobranca|cobrancas|bank-reconciliation|folha-pagamento|contratos|contracts)/i;

/**
 * Tabelas que decidem quem pode fazer o quê.
 *
 * Ler `profiles` não é, por si só, um risco de autorização — as listagens de
 * colaboradores lêem a mesma tabela só para a mostrar. O que torna a leitura
 * perigosa é o que se faz com ela a seguir: comparar um `role`/`company_id`, ou
 * escrever. Sem esse segundo sinal, isto é um ecrã incompleto, não uma falha de
 * acesso — e classificá-lo como tal só inflacionaria a lista.
 */
const TENANT_TABLES = new Set(["profiles", "companies", "company_settings"]);

/**
 * Uma DECISÃO de autorização, não uma menção.
 *
 * A primeira versão desta regra procurava as palavras `admin`, `gestor` e
 * `company_id` na janela — e apanhou 111 casos, quase todos falsos: `admin` é o
 * nome da variável do cliente Supabase (`await admin.from(…)`), presente na
 * própria linha da consulta, e `.eq("company_id", …)` é âmbito de leitura, não
 * uma decisão de acesso. É o mesmo erro que a T17-A registou três vezes:
 * **mencionar ≠ usar**.
 *
 * O que conta é uma comparação de `role`, uma recusa explícita, ou a leitura do
 * perfil da própria sessão (`.eq("id", user.id)`) — o padrão do guard inline.
 */
const AUTHZ_DECISION =
  /\brole\s*(?:===|!==|==|!=)|\?\.role\b\s*(?:===|!==)|\[\s*["'](?:admin|gestor)["']|includes\(\s*\w*\??\.?role|unauthorized|forbidden|(?:n|N)ão autorizado|(?:s|S)em permiss/;
const SESSION_PROFILE_LOOKUP = /\.eq\(\s*["']id["']\s*,\s*\w+\.id\s*\)/;

const DOCUMENT_PATH = /collaborator-documents|documento|documents/i;

/** Onde o pior caso é uma tabela vazia num ecrã de leitura. */
const TELEMETRY = /route-metrics|observability|audit\.ts|notifications|push-notify|keep-alive|health/i;

// ─── Utilidades de leitura estática ─────────────────────────────────────────

const FN_DECL =
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/;

/** Nome da função/acção que contém a linha — a declaração mais próxima acima. */
function enclosingFunction(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(FN_DECL);
    if (m) return m[1] ?? m[2];
  }
  return null;
}

/** A tabela/view consultada, do `.from("…")` mais próximo à frente. */
function nearbyTable(text) {
  const m = text.match(/\.from\(\s*["'`]([\w.]+)["'`]/);
  return m ? m[1] : null;
}

/** O fallback que apaga a diferença entre "vazio" e "falhou". */
function fallbackOf(text) {
  const found = [];
  if (/\?\?\s*\[\]/.test(text)) found.push("?? []");
  if (/\?\?\s*0\b/.test(text)) found.push("?? 0");
  if (/\|\|\s*\[\]/.test(text)) found.push("|| []");
  if (/\|\|\s*0\b/.test(text)) found.push("|| 0");
  if (/\?\?\s*null\b/.test(text)) found.push("?? null");
  return found;
}

const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

/**
 * O código verifica logo a seguir que o valor lido existe, e desiste se não
 * existir?
 *
 * Isto separa dois destinos muito diferentes para o mesmo erro ignorado:
 *
 * - **fail-closed** — a consulta falha, `data` vem `null`, o `if (!x) return`
 *   apanha-o e nega. O utilizador leva uma recusa errada, mas nada de errado é
 *   escrito nem mostrado como verdadeiro. É um bug de diagnóstico: perde-se a
 *   causa real, que passa a ser indistinguível de "sem permissão".
 * - **fail-open** — ninguém verifica, e o `null` segue viagem para uma decisão,
 *   um cálculo ou uma escrita.
 *
 * Tratar os dois como igualmente graves inflacionaria a lista e faria perder de
 * vista os que interessam.
 */
function failsClosed(lines, idx, binding, span = 12) {
  const after = lines.slice(idx, idx + span).join("\n");
  const guard = new RegExp(
    `(?:if\\s*\\(\\s*!\\s*${binding}\\b|${binding}\\s*(?:==|===)\\s*null|!\\s*${binding}\\s*(?:\\|\\||\\)))`,
  );
  if (!guard.test(after)) return false;
  return /\breturn\b|\bthrow\b|redirect\s*\(|notFound\s*\(/.test(after);
}

/** A janela a seguir à consulta escreve na base? Ler mal e depois escrever é o
 *  caso em que o erro ignorado deixa de ser cosmético. */
function writesAfter(lines, idx, span = 40) {
  return lines.slice(idx, idx + span).some((l) => WRITE.test(l));
}

// ─── Severidade ─────────────────────────────────────────────────────────────
//
// A regra é uma só: quanto mais perto a falha estiver de PARECER SUCESSO, mais
// grave é. Não se sobe a severidade por haver muitos casos no mesmo ficheiro —
// inflacionar uma lista é a forma mais rápida de a tornar inútil.

function severityOf(o) {
  const enganaComoSucesso = o.fallback.length > 0 || o.writeContext;

  // Fail-closed nunca é CRITICAL: a falha vira uma recusa, não uma confirmação
  // falsa. Continua a merecer correcção — perde-se a causa real — mas não
  // compete em prioridade com um `null` que segue para uma escrita.
  if (o.failMode === "fail-closed") return o.financialRisk ? "MEDIUM" : "LOW";

  if ((o.financialRisk || o.tenantRisk) && enganaComoSucesso) return "CRITICAL";
  if (o.financialRisk || o.tenantRisk) return "HIGH";
  if (o.telemetry) return "LOW";
  if (o.documentSurface) return "HIGH";
  if (o.writeContext) return "HIGH";
  if (o.fallback.length > 0) return "MEDIUM";
  return "MEDIUM";
}

function userImpactOf(o) {
  if (o.failMode === "fail-closed") return "a falha vira uma recusa: causa real perdida, indistinguível de 'sem permissão'";
  if (o.tenantRisk) return "decisão de acesso tomada sobre um perfil que pode não ter sido lido";
  if (o.financialRisk && o.fallback.includes("?? 0")) return "erro de consulta apresentado como 0 € — indistinguível de um valor real";
  if (o.financialRisk) return "montante ou documento financeiro em falta sem qualquer aviso";
  if (o.documentSurface) return "um documento que não carrega parece não existir";
  if (o.writeContext) return "escrita decidida a partir de uma leitura que pode ter falhado";
  if (o.fallback.length > 0) return "lista vazia indistinguível de ausência real de dados";
  return "informação em falta no ecrã, sem sinal de erro";
}

// ─── Ordem de remediação ────────────────────────────────────────────────────
//
// A ordem vem do handoff de 2026-08-08 §8. `payments.ts` e `invoices.ts` são a
// excepção: tocam exactamente a zona da regressão financeira ainda sem
// diagnóstico, e ficam bloqueados até haver um BEFORE real.

const BLOCKED = /src\/app\/actions\/(payments|invoices)\.ts$/;

/**
 * "Action de escrita" quer dizer que o ficheiro **escreve**.
 *
 * A primeira versão desta regra bastava-se com "está em `actions/` ou tem
 * `use server`", e pôs 19 ocorrências de ficheiros puramente de leitura
 * (`reports.ts`, `map.ts`, `pendencias.ts`, `calendar.ics`) no lote das actions
 * de escrita. O lote existe para ordenar o trabalho por risco: um erro
 * ignorado numa página de leitura, no pior caso, mostra uma tabela vazia; num
 * ficheiro que escreve, autoriza uma escrita que não devia acontecer.
 *
 * Misturar os dois torna o número do lote inútil para decidir por onde começar.
 */
const WRITES = /\.(insert|update|upsert|delete|rpc)\s*\(/;

function batchOf(o) {
  if (BLOCKED.test(o.path)) return "BLOCKED_FINANCIAL_INCIDENT";
  // Acima da ordem do handoff: uma leitura de autorização que falhou em
  // silêncio decide quem entra onde. Não é "informação em falta no ecrã".
  if (o.tenantRisk) return "BATCH_0_TENANT_AUTORIZACAO";
  if (o.financialRisk) return "BATCH_1_SUPERFICIE_FINANCEIRA";
  if (o.documentSurface) return "BATCH_2_DOCUMENTOS_COLABORADOR";
  if ((o.serverAction || o.apiRoute) && o.fileWrites) return "BATCH_3_ACTIONS_ESCRITA";
  return "BATCH_4_PAGINAS_LEITURA";
}

// ─── Varrimento ─────────────────────────────────────────────────────────────

const FILES = trackedFiles().filter((f) => /\.(ts|tsx)$/.test(f));
const findings = [];

for (const rel of FILES) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
  if (!src.includes("data:")) continue;

  const lines = src.split(/\r?\n/);
  const isAction = /^src\/app\/actions\//.test(rel) || /_actions\//.test(rel) || /["']use server["']/.test(src);
  const isApi = /^src\/app\/api\//.test(rel);
  const fileWrites = WRITES.test(src);

  IGNORED_ERROR.lastIndex = 0;
  let m;
  while ((m = IGNORED_ERROR.exec(src)) !== null) {
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    const idx = line - 1;
    // Janela: a consulta encadeia-se por várias linhas e o fallback costuma
    // ficar logo a seguir.
    const window = lines.slice(idx, idx + 8).join("\n");

    // Ver `NOT_A_QUERY`: uma linha que devolve `{ data }` mas não é consulta.
    if (NOT_A_QUERY.test(lines[idx] ?? "")) continue;

    const table = nearbyTable(window);
    const fallback = fallbackOf(window);

    const o = {
      path: rel,
      line,
      fn: enclosingFunction(lines, idx),
      binding: m[1],
      table,
      pattern: "const { data } = await … (error não desestruturado)",
      fallback,
      writeContext: writesAfter(lines, idx),
      serverAction: isAction,
      apiRoute: isApi,
      fileWrites,
      financialRisk: (table != null && FINANCIAL_TABLES.has(table)) || FINANCIAL_PATH.test(rel),
      // Só conta como risco de autorização se a leitura for USADA para decidir
      // — comparar role/company_id, ou escrever a seguir. Ver TENANT_TABLES.
      tenantRisk:
        table != null && TENANT_TABLES.has(table)
        && (AUTHZ_DECISION.test(window) || SESSION_PROFILE_LOOKUP.test(window)),
      documentSurface: DOCUMENT_PATH.test(rel),
      telemetry: TELEMETRY.test(rel),
      failMode: failsClosed(lines, idx, m[1]) ? "fail-closed" : "unchecked",
    };

    o.userImpact = userImpactOf(o);
    o.severity = severityOf(o);
    o.recommendedBatch = batchOf(o);

    findings.push(o);
  }
}

findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

// ─── Saída ──────────────────────────────────────────────────────────────────

function tally(key) {
  const out = {};
  for (const f of findings) out[f[key]] = (out[f[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

const byFile = {};
for (const f of findings) byFile[f.path] = (byFile[f.path] ?? 0) + 1;

const fallbackTally = {};
for (const f of findings) {
  if (f.fallback.length === 0) fallbackTally["(sem fallback)"] = (fallbackTally["(sem fallback)"] ?? 0) + 1;
  for (const fb of f.fallback) fallbackTally[fb] = (fallbackTally[fb] ?? 0) + 1;
}

const report = {
  generatedBy: "scripts/audit-ignored-query-errors.mjs",
  task: "T17-B1",
  note:
    "Inventário estático. Nada foi corrigido. Não contém dados reais, mensagens "
    + "da base, credenciais nem PII — apenas caminhos, linhas, nomes de tabela e "
    + "nomes de função lidos do código versionado.",
  blockedNote:
    "payments.ts e invoices.ts ficam em BLOCKED_FINANCIAL_INCIDENT: tocam a zona "
    + "da regressão financeira ainda sem diagnóstico e não podem ser alterados "
    + "antes de um BEFORE real.",
  total: findings.length,
  filesAffected: Object.keys(byFile).length,
  bySeverity: tally("severity"),
  byFailMode: tally("failMode"),
  byBatch: tally("recommendedBatch"),
  byFallback: Object.fromEntries(Object.entries(fallbackTally).sort((a, b) => b[1] - a[1])),
  topFiles: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 20)),
  findings,
};

const outArg = process.argv.indexOf("--output");
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;
const json = `${JSON.stringify(report, null, 2)}\n`;

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");
  console.error(`✔ backlog gravado em ${outPath}`);
} else {
  process.stdout.write(json);
}

console.error("");
console.error(`Erros de consulta ignorados: ${report.total} em ${report.filesAffected} ficheiros`);
console.error("Por severidade:");
for (const [k, v] of Object.entries(report.bySeverity)) console.error(`  ${k.padEnd(10, ".")} ${v}`);
console.error("Por lote:");
for (const [k, v] of Object.entries(report.byBatch)) console.error(`  ${k.padEnd(32, ".")} ${v}`);
console.error("Por fallback:");
for (const [k, v] of Object.entries(report.byFallback)) console.error(`  ${k.padEnd(16, ".")} ${v}`);
console.error("");
