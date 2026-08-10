/**
 * T17-B1 — Mapa dos guards de autenticação inline nas server actions.
 *
 * 🚨 ESTÁTICO E OFFLINE. Não liga ao Supabase, não lê `.env`, não faz rede.
 *
 * Uso:
 *   node scripts/audit-auth-guards.mjs --output reports/auth-guard-inline.json
 *
 * ----------------------------------------------------------------------------
 *
 * 🔴 O QUE ESTE RELATÓRIO **NÃO** DIZ
 *
 * Não diz que estas actions estão desprotegidas. **Nenhuma está.** A T17-A
 * auditou as 35 actions e encontrou **zero** sem autenticação. O que estes 20
 * ficheiros têm é uma cópia à mão do que `requireProfile` já faz.
 *
 * O custo da duplicação é futuro, não presente: quando a regra de acesso
 * mudar, tem de mudar em 21 sítios, e o que falhar não dá erro — continua a
 * autorizar pela regra antiga, em silêncio.
 *
 * Por isso a recomendação é CENTRALIZAR, não "corrigir". A T17-B1 **não altera
 * nenhuma action** — mudar autenticação numa task de limpeza seria trocar um
 * risco conhecido por um desconhecido.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

/**
 * A forma canónica, lida de `src/lib/auth-guard.ts`: sessão via `getUser()`,
 * perfil via chave administrativa, `select("id, company_id, role")`,
 * `.single()`, recusa se não houver perfil, recusa se o papel não estiver na
 * lista, e o `company_id` vem SEMPRE da sessão.
 */
const CANONICAL = {
  module: "src/lib/auth-guard.ts",
  fn: "requireProfile",
  select: "id, company_id, role",
  cardinality: "single",
  companyIdSource: "sessão",
};

/**
 * Classificação manual. Cada linha é uma afirmação verificável sobre a
 * diferença entre o guard inline e `requireProfile` — não um palpite.
 *
 *   SAFE_TO_CENTRALIZE — mesma semântica; a troca é mecânica
 *   NEEDS_TEST         — mesma semântica, mas o ficheiro tem muitos pontos de
 *                        chamada ou efeitos a jusante que pedem teste antes
 *   SEMANTIC_DIFFERENCE— o guard inline faz algo que `requireProfile` não faz
 *   STANDBY            — o próprio ficheiro está em standby; não mexer
 */
const CLASSIFICATION = {
  "src/app/(dashboard)/dashboard/calendario/_actions/create-service.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "guard idêntico ao canónico, um único ponto de chamada.",
  },
  "src/app/(dashboard)/dashboard/calendario/_actions/reschedule.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "guard idêntico ao canónico, um único ponto de chamada.",
  },
  "src/app/(dashboard)/dashboard/calendario/_actions/update-service.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "já está factorizado num helper local `authorize()` — a troca é substituir o corpo desse helper.",
  },
  "src/app/actions/absences.ts": {
    verdict: "SEMANTIC_DIFFERENCE",
    notes:
      "além do guard, lê `skills` e `full_name` de outros perfis para o motor de "
      + "substituição, e admite o papel `colaborador` a agir sobre si próprio. Só a "
      + "parte do guard centraliza; as outras leituras ficam.",
  },
  "src/app/actions/auth.ts": {
    verdict: "SEMANTIC_DIFFERENCE",
    notes:
      "é a própria superfície de autenticação (login, convite, reposição de password). "
      + "Centralizar aqui arrisca dependência circular com o guard. Tratar em último.",
  },
  "src/app/actions/building-cards.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "já tem `getCompanyId()` e `requireManager()` locais — trocar o corpo dos dois.",
  },
  "src/app/actions/cancellations.ts": {
    verdict: "NEEDS_TEST",
    notes:
      "o guard lê também `full_name` para registar quem cancelou; a troca tem de "
      + "preservar esse campo. Cancelamento tardio tem efeitos de notificação a jusante.",
  },
  "src/app/actions/clientes.ts": {
    verdict: "NEEDS_TEST",
    notes:
      "5 pontos de chamada. Valida `profile.company_id !== input.company_id` em vez de "
      + "confiar no input — comportamento correcto que a migração tem de manter.",
  },
  "src/app/actions/colaboradores.ts": {
    verdict: "SEMANTIC_DIFFERENCE",
    notes:
      "6 pontos de chamada e regras por papel diferentes por função (gestor cria mas não "
      + "apaga; colaborador vê-se a si). Lê ainda `iban`/`hourly_rate`/`nif`, que são "
      + "dados sensíveis e não pertencem ao guard.",
  },
  "src/app/actions/contratos.ts": {
    verdict: "NEEDS_TEST",
    notes:
      "3 pontos de chamada. Valida `company_id` contra o input, como `clientes.ts`. "
      + "Superfície financeira — qualquer mexida cruza a zona congelada.",
  },
  "src/app/actions/csv-import.ts": {
    verdict: "SEMANTIC_DIFFERENCE",
    notes:
      "`getCallerContext()` distingue admin de gestor para limitar o que cada um pode "
      + "importar (gestor só cria colaborador — correcção P0-6). `requireProfile` devolve "
      + "o papel mas não essa regra; ela fica na action.",
  },
  "src/app/actions/email.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "guard idêntico, um ponto de chamada.",
  },
  "src/app/actions/equipas.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "guard idêntico; ordem do select invertida (`role, company_id`), sem efeito.",
  },
  "src/app/actions/intervencoes.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "já factorizado em `requireManager()` local.",
  },
  "src/app/actions/locations.ts": {
    verdict: "NEEDS_TEST",
    notes: "4 pontos de chamada; `updateLocationAccess` toca códigos de acesso a locais.",
  },
  "src/app/actions/map.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "guard idêntico, leitura apenas.",
  },
  "src/app/actions/notifications.ts": {
    verdict: "NEEDS_TEST",
    notes:
      "6 pontos de chamada e o `company_id` nem sempre vem da sessão (T17-A §4.3). "
      + "Centralizar corrige isso — e é precisamente por isso que precisa de teste.",
  },
  "src/app/actions/vacation.ts": {
    verdict: "SEMANTIC_DIFFERENCE",
    notes:
      "6 pontos de chamada com dois papéis em jogo: o colaborador pede, o gestor aprova. "
      + "Lê ainda `vacation_balance`/`contract_start`. Guard e regra de negócio estão "
      + "misturados e têm de ser separados antes de centralizar.",
  },
  "src/app/actions/vehicles.ts": {
    verdict: "SAFE_TO_CENTRALIZE",
    notes: "já tem `getCompanyId()` local; 9 escritas, todas a jusante do mesmo guard.",
  },
  "src/app/actions/whatsapp.ts": {
    verdict: "STANDBY",
    notes:
      "o ficheiro inteiro está STANDBY no inventário — implementação da Meta Cloud API "
      + "deliberadamente não activa. Não mexer enquanto o destino dele não estiver decidido.",
  },
};

// ─── Extracção de factos ────────────────────────────────────────────────────

function trackedActions() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean)
    .filter((f) => /^src\/app\/(actions\/|.*_actions\/)/.test(f) && /\.ts$/.test(f));
}

const PROFILE_SELECT = /from\(\s*["']profiles["']\s*\)[\s\S]{0,120}?\.select\(\s*["']([^"']+)["']/g;
const LOCAL_HELPER = /(?:async\s+function|const)\s+(requireManager|requireAdmin|getCompanyId|getCallerContext|authorize|getCaller)\b/g;

const entries = [];
let central = 0;

for (const rel of trackedActions()) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (!/["']use server["']/.test(src)) continue;

  if (/requireProfile/.test(src)) { central += 1; continue; }

  PROFILE_SELECT.lastIndex = 0;
  LOCAL_HELPER.lastIndex = 0;

  const manual = CLASSIFICATION[rel];
  entries.push({
    path: rel,
    guardStyle: "inline: getUser() → ler profiles com chave administrativa → verificar role",
    getUserCalls: (src.match(/auth\.getUser\(\)/g) ?? []).length,
    profileSelects: [...new Set([...src.matchAll(PROFILE_SELECT)].map((m) => m[1]))],
    cardinality: /\.single\(\)/.test(src) ? "single" : (/\.maybeSingle\(\)/.test(src) ? "maybeSingle" : "—"),
    rolesReferenced: [...new Set([...src.matchAll(/["'](admin|gestor|colaborador|colaboradora)["']/g)].map((m) => m[1]))],
    localHelpers: [...new Set([...src.matchAll(LOCAL_HELPER)].map((m) => m[1]))],
    validatesCompanyIdAgainstInput: /company_id\s*!==\s*\w+\.company_id|\w+\.company_id\s*!==\s*profile\.company_id/.test(src),
    writes: (src.match(/\.(insert|update|upsert|delete)\s*\(/g) ?? []).length,
    // Igual ao canónico em cardinalidade e num select que contenha company_id+role?
    matchesCanonicalShape:
      /\.single\(\)/.test(src)
      && [...src.matchAll(PROFILE_SELECT)].some((m) => /company_id/.test(m[1]) && /role/.test(m[1])),
    verdict: manual?.verdict ?? "STANDBY",
    notes: manual?.notes ?? "sem classificação manual — tratar como STANDBY",
    classified: manual != null,
  });
}

entries.sort((a, b) => a.path.localeCompare(b.path));

const byVerdict = {};
for (const e of entries) byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;

const report = {
  generatedBy: "scripts/audit-auth-guards.mjs",
  task: "T17-B1",
  backlogId: "AUTH_GUARD_CENTRALIZATION",
  note:
    "NENHUMA destas actions está desprotegida — a T17-A encontrou zero sem "
    + "autenticação. O defeito é duplicação, não vulnerabilidade. Nada foi alterado "
    + "nesta ronda.",
  canonical: CANONICAL,
  usingCentralGuard: central,
  inlineGuards: entries.length,
  byVerdict: Object.fromEntries(Object.entries(byVerdict).sort((a, b) => b[1] - a[1])),
  entries,
};

const outArg = process.argv.indexOf("--output");
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;
const json = `${JSON.stringify(report, null, 2)}\n`;

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");
  console.error(`✔ mapa gravado em ${outPath}`);
} else {
  process.stdout.write(json);
}

console.error("");
console.error(`Guard central (requireProfile): ${report.usingCentralGuard}`);
console.error(`Guard inline duplicado:         ${report.inlineGuards}`);
for (const [k, v] of Object.entries(report.byVerdict)) console.error(`  ${k.padEnd(22, ".")} ${v}`);
console.error("");
