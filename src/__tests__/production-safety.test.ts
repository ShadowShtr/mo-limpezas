// ============================================================================
// GUARDA — nenhum comando de deploy manual de produção no repositório
// ============================================================================
// Origem: incidente de produção de 2026-08-05 (deploy indevido da branch
// ampla via `vercel --prod` manual + chave administrativa inválida — ver
// CLAUDE.md, ponto de paragem de 2026-08-05, e docs/PRODUCTION-RUNBOOK.md).
//
// Regra: `vercel --prod`, `vercel deploy --prod`, `vercel --force` e
// variações nunca devem aparecer em `package.json` (scripts) nem em nenhum
// script versionado (`scripts/**`) — nem como "prod:deploy" nem qualquer
// outro atalho. O único caminho para produção é merge em `master` +
// publicação automática pela Vercel (ver AGENTS.md, REGRA ZERO).
//
// Este teste não impede menções HISTÓRICAS em Markdown (CLAUDE.md já
// documenta o incidente e sessões antigas citando o comando, marcadas
// explicitamente como proibidas) — só falha se o comando aparecer como
// algo EXECUTÁVEL: um script de package.json, ou um ficheiro .mjs/.ts/.js/
// .sh/.ps1 em scripts/ que o chame de facto.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const DANGEROUS_PATTERNS = [
  /vercel\s+--prod\b/,
  /vercel\s+deploy\s+--prod\b/,
  /vercel\s+--force\b/,
];

function walkExecutable(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git" || name === ".vercel") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkExecutable(p, out);
    else if (/\.(mjs|ts|js|sh|ps1|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("production-safety — nenhum comando de deploy manual", () => {
  it("package.json não tem nenhum script com vercel --prod/--force", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const offenders: string[] = [];
    for (const [name, cmd] of Object.entries(scripts)) {
      if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) offenders.push(`${name}: ${cmd}`);
    }
    expect(offenders).toEqual([]);
  });

  it("nenhum script em scripts/ chama vercel --prod/deploy --prod/--force", () => {
    const scriptsDir = path.join(ROOT, "scripts");
    if (!fs.existsSync(scriptsDir)) return;
    // scripts/audit-reversoes.mjs já existe e AVISA contra 'vercel --prod'
    // manual dentro de uma mensagem de warning (não invoca o comando) —
    // é o próprio detetor deste problema, não uma instância dele.
    const ALLOWLIST_MENTION_ONLY = new Set(["audit-reversoes.mjs"]);
    const offenders: string[] = [];
    for (const file of walkExecutable(scriptsDir)) {
      if (ALLOWLIST_MENTION_ONLY.has(path.basename(file))) continue;
      const content = fs.readFileSync(file, "utf8");
      if (DANGEROUS_PATTERNS.some((re) => re.test(content))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nenhum workflow de CI (.github/workflows) dispara vercel --prod/--force", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    if (!fs.existsSync(dir)) return;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!fs.statSync(p).isFile()) continue;
      const content = fs.readFileSync(p, "utf8");
      if (DANGEROUS_PATTERNS.some((re) => re.test(content))) offenders.push(path.relative(ROOT, p));
    }
    expect(offenders).toEqual([]);
  });

  it("AGENTS.md contém a REGRA ZERO", () => {
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain("REGRA ZERO");
    expect(agents).toContain("vercel --prod");
    expect(agents).toContain("fix/atomic-contract-calendar-sync");
  });

  it("docs/PRODUCTION-RUNBOOK.md existe e cobre deploy, rollback e incidente", () => {
    const p = path.join(ROOT, "docs", "PRODUCTION-RUNBOOK.md");
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, "utf8");
    expect(content).toContain("Rollback");
    expect(content).toMatch(/vercel promote/);
    expect(content).toMatch(/Resposta a incidente/i);
  });

  it("scripts de escrita já alinhados com a regra (dry-run por padrão + --apply + --confirm) continuam a cumpri-la", () => {
    // scripts/run-migrations.mjs em master ainda usa o desenho antigo
    // (--dry-run/--baseline/--seed, aplica por omissão sem --apply) — não
    // tocado nesta PR (só documentação/guardas, ver AGENTS.md REGRA ZERO
    // #5: nada de conserto técnico misturado aqui). Registado como
    // pendência no runbook (docs/PRODUCTION-RUNBOOK.md secção 8), não
    // reforçado por este teste até ser corrigido numa PR própria.
    const candidates = [
      "scripts/test-tenants/provision.mjs",
      "scripts/test-tenants/cleanup.mjs",
    ];
    for (const rel of candidates) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, "utf8");
      expect(content, `${rel} deve checar --apply`).toMatch(/--apply/);
      expect(content, `${rel} deve exigir --confirm`).toMatch(/--confirm/);
    }
  });
});
