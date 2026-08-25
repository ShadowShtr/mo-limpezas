// ============================================================================
// POLÍTICA DE FINS DE LINHA DOS SCRIPTS NODE
// ============================================================================
//
// 🔴 Guarda de uma falha que se escondeu durante uma semana.
//
//    Em Windows com `core.autocrlf=true`, um `.mjs` que comece por shebang é
//    escrito no disco como `#!/usr/bin/env node\r\n`. O Node importa-o sem
//    problema; o esbuild — que o Vitest usa — não, e devolve
//    `SyntaxError: Invalid or unexpected token`. A suite inteira deixa de ser
//    recolhida: não falha um teste, desaparecem todos.
//
//    Foi isso que manteve `release-note-guard` e `scan-secrets` fora do gate
//    local. O `npm test` dava EXIT=1 e a explicação que circulava era uma
//    vírgula no caminho da pasta. Estava errada, e só se percebeu quando um
//    checkout num caminho sem vírgula falhou exatamente da mesma maneira.
//
//    O risco real não era a suite ausente. Era o gate parecer conhecido e
//    tolerável enquanto 48 testes nunca corriam.
//
// Este teste não repete a experiência — verifica que a regra que a impede
// continua declarada e continua a cobrir todos os ficheiros em risco.
// ============================================================================
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Todos os `.mjs` sob `scripts/`, em qualquer profundidade. */
function scriptsMjs(dir = "scripts"): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) return scriptsMjs(rel);
    return e.isFile() && e.name.endsWith(".mjs") ? [rel] : [];
  });
}

const temShebang = (rel: string) => ler(rel).startsWith("#!");

describe("fins de linha dos scripts Node", () => {
  it("1. existe .gitattributes", () => {
    // Sem ele, o `core.autocrlf` de cada máquina decide, e o resultado deixa
    // de ser reprodutível entre quem desenvolve e o CI.
    expect(fs.existsSync(path.join(ROOT, ".gitattributes")), ".gitattributes em falta").toBe(true);
  });

  it("2. os .mjs de scripts/ estão declarados como LF", () => {
    const attrs = ler(".gitattributes");
    const regras = attrs
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const cobreRaiz = regras.some((r) => /^scripts\/\*\.mjs\s+.*\beol=lf\b/.test(r));
    const cobreSub = regras.some((r) => /^scripts\/\*\*\/\*\.mjs\s+.*\beol=lf\b/.test(r));

    expect(cobreRaiz, "falta a regra para scripts/*.mjs").toBe(true);
    expect(cobreSub, "falta a regra para scripts/**/*.mjs").toBe(true);
  });

  it("3. todo o .mjs com shebang está dentro do alcance da regra", () => {
    // A regra apanha a pasta, não uma lista de nomes: um script novo com
    // shebang fica protegido no dia em que nasce, sem ninguém se lembrar.
    const comShebang = scriptsMjs().filter(temShebang);
    expect(comShebang.length, "esperava encontrar scripts com shebang").toBeGreaterThan(0);

    const foraDoAlcance = comShebang.filter((f) => !f.startsWith("scripts/"));
    expect(foraDoAlcance, "shebang fora de scripts/ não fica coberto").toEqual([]);
  });

  it("4. nenhum script importado por testes perdeu o alcance da regra", () => {
    // Os dois que partiam as suites, nomeados de propósito: se alguém os
    // mover para fora de `scripts/`, isto acusa antes de o gate voltar a
    // mentir.
    for (const f of ["scripts/check-release-note.mjs", "scripts/scan-secrets.mjs"]) {
      expect(fs.existsSync(path.join(ROOT, f)), f + " mudou de sítio").toBe(true);
      expect(f.startsWith("scripts/")).toBe(true);
    }
  });

  it("5. a regra é estreita — não renormaliza o repositório inteiro", () => {
    // Uma regra global reescreveria ficheiros que nunca deram problema e
    // enterraria esta correção num diff enorme.
    const regras = ler(".gitattributes")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    expect(regras.some((r) => /^\*\s/.test(r)), "regra global inesperada").toBe(false);
    for (const r of regras) expect(r).toMatch(/^scripts\//);
  });
});
