// ============================================================================
// FERRAMENTAS DOS GATES — DECLARADAS, INSTALADAS, E NUNCA DESCARREGADAS
// ============================================================================
//
// O defeito que isto fecha.
//
// O `t08-cli.test.ts` lançava os seus subprocessos com `execFile("npx",
// ["tsx", ...])`, e o `prebuild` corria `npx tsx scripts/check-env.ts`. Só que
// o `tsx` não estava declarado — nem em `dependencies`, nem em
// `devDependencies`, nem no `package-lock.json`. Um `npm ci` limpo não o
// instalava.
//
// O `npx`, perante uma ferramenta que não encontra instalada, vai buscá-la à
// rede. Numa máquina de desenvolvimento o cache do npx já a tem e tudo corre em
// segundos; num runner limpo o download é o caminho normal, e os três casos do
// t08 que lançam subprocessos ficavam presos até ao teto de 60 s cada — 180 s
// de ficheiro, sempre os mesmos três. Confirmou-se que o master puro reproduzia
// a falha, sem uma linha das frentes em curso.
//
// Ou seja: `npm test` e `npm run build` dependiam de rede a meio da execução,
// para instalar uma ferramenta que o projeto nunca declarou.
//
// Estes guards não medem tempo — medir tempo faria um ensaio frágil, que passa
// numa máquina rápida e falha noutra. Afirmam a propriedade estrutural: a
// ferramenta está declarada, está no lockfile, está instalada, e nenhum caminho
// executável a invoca por `npx`.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const pkg = JSON.parse(ler("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** As ferramentas que os gates executam e que, por isso, têm de vir do lockfile. */
const FERRAMENTAS = ["tsx"] as const;

describe("ferramentas dos gates — declaradas e instaladas", () => {
  it.each(FERRAMENTAS)("🔴 `%s` é dependência directa declarada", (ferramenta) => {
    const declarada =
      pkg.dependencies?.[ferramenta] ?? pkg.devDependencies?.[ferramenta] ?? null;
    expect(
      declarada,
      `${ferramenta} tem de estar em dependencies ou devDependencies: os gates executam-no, ` +
        "e o que não está declarado não é instalado pelo `npm ci`",
    ).not.toBeNull();
  });

  it.each(FERRAMENTAS)("🔴 `%s` está no package-lock.json", (ferramenta) => {
    const lock = JSON.parse(ler("package-lock.json")) as {
      packages: Record<string, unknown>;
    };
    expect(
      Object.keys(lock.packages),
      `${ferramenta} tem de constar do lockfile para o \`npm ci\` o instalar de forma reproduzível`,
    ).toContain(`node_modules/${ferramenta}`);
  });

  it.each(FERRAMENTAS)("🔴 `%s` está instalado em node_modules/.bin", (ferramenta) => {
    const base = path.join(ROOT, "node_modules", ".bin");
    // No Windows o executável é o `.cmd`; nos outros é o script sem extensão.
    const candidatos = [path.join(base, ferramenta), path.join(base, `${ferramenta}.cmd`)];
    expect(
      candidatos.some((c) => fs.existsSync(c)),
      `${ferramenta} não está em node_modules/.bin — um \`npm ci\` limpo tem de o instalar`,
    ).toBe(true);
  });
});

describe("nenhum caminho executável resolve ferramentas por `npx`", () => {
  // Um `npx` num comentário é documentação e não faz mal a ninguém. O que não
  // pode existir é `npx` no que corre: scripts do npm e chamadas de processo.
  it("🔴 nenhum script do package.json invoca `npx`", () => {
    const infractores = Object.entries(pkg.scripts)
      .filter(([, comando]) => /\bnpx\b/.test(comando))
      .map(([nome, comando]) => `${nome}: ${comando}`);
    expect(
      infractores,
      "os scripts do npm já têm node_modules/.bin no PATH — invocar `npx` abre a porta " +
        "a resolver da rede uma ferramenta em falta, em vez de falhar",
    ).toEqual([]);
  });

  it("🔴 o t08-cli lança os subprocessos pelo binário local, não por `npx`", () => {
    const codigo = ler("src/__tests__/t08-cli.test.ts")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

    expect(codigo).not.toMatch(/execFileAsync\(\s*["']npx["']/);
    expect(codigo).toContain("node_modules");
  });
});
