// ============================================================================
// GUARD — alteração visível exige uma release note NOVA
// ============================================================================
// Exercita a lógica de `scripts/check-release-note.mjs` com diffs simulados.
//
// 🔴 Porque foi reescrito: a primeira versão deste ficheiro verificava apenas
//    que a pasta existia e tinha pelo menos uma nota. Isso significava que
//    alterar quarenta ficheiros de UI sem escrever nada passava — a nota antiga
//    continuava lá. Era verde por não verificar nada, que é a pior espécie de
//    guard: dá confiança sem a merecer.
//
//    Agora compara o diff real. O CI passou a fazer `fetch-depth: 0` para ter a
//    base disponível — a árvore continua a ser o HEAD do autor.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classificar } from "../../scripts/check-release-note.mjs";
import { RELEASE_NOTES } from "@/release-notes";

const RAIZ = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

/** Um diff simulado, na forma que `git diff --name-status` produz. */
function diff(...entradas: [string, string][]) {
  return entradas.map(([status, path]) => ({ status, path }));
}

describe("🔴 USER_VISIBLE_CHANGE_WITHOUT_RELEASE_NOTE", () => {
  // Cenário A: alteração visível sem nota → tem de falhar.
  it("A. componente alterado SEM release note nova → FAIL", () => {
    const r = classificar(diff(["M", "src/components/foo.tsx"]));
    expect(r.problemas.length).toBeGreaterThan(0);
    expect(r.problemas.join("\n")).toContain("sem nenhuma release note nova");
  });

  // Cenário B: alteração visível com nota nova → passa.
  it("B. componente alterado COM release note nova → PASS", () => {
    const r = classificar(diff(
      ["M", "src/components/foo.tsx"],
      ["A", "src/release-notes/2026-08-20-x.ts"],
    ));
    expect(r.problemas).toEqual([]);
    expect(r.notasNovas).toEqual(["src/release-notes/2026-08-20-x.ts"]);
  });

  // Cenário C: modificar uma nota existente em vez de criar → falha duas vezes.
  it("C. release note existente MODIFICADA → FAIL (é imutável)", () => {
    const r = classificar(diff(
      ["M", "src/components/foo.tsx"],
      ["M", "src/release-notes/2026-08-19-financeiro-e-anexos.ts"],
    ));
    expect(r.problemas.join("\n")).toContain("imutável");
    // E continua a faltar uma nota nova.
    expect(r.notasNovas).toEqual([]);
  });

  // Cenário D: só documentação → não exige nada.
  it("D. apenas docs → PASS", () => {
    const r = classificar(diff(["M", "docs/qualquer.md"]));
    expect(r.problemas).toEqual([]);
    expect(r.visiveis).toEqual([]);
  });

  it("apagar uma release note também é erro", () => {
    const r = classificar(diff(["D", "src/release-notes/2026-08-19-financeiro-e-anexos.ts"]));
    expect(r.problemas.join("\n")).toContain("imutável");
  });

  it("mexer só no index.ts não conta como escrever uma nota", () => {
    // O index agrega; a nota é o ficheiro próprio.
    const r = classificar(diff(
      ["M", "src/components/foo.tsx"],
      ["M", "src/release-notes/index.ts"],
    ));
    expect(r.problemas.join("\n")).toContain("sem nenhuma release note nova");
  });

  it("testes, docs e reports não são superfície visível", () => {
    const r = classificar(diff(
      ["M", "src/__tests__/algo.test.ts"],
      ["M", "docs/algo.md"],
      ["M", "reports/code-audit.json"],
    ));
    expect(r.visiveis).toEqual([]);
    expect(r.problemas).toEqual([]);
  });

  it("src/app conta como visível", () => {
    const r = classificar(diff(["M", "src/app/(dashboard)/dashboard/page.tsx"]));
    expect(r.visiveis.length).toBe(1);
    expect(r.problemas.length).toBeGreaterThan(0);
  });

  it("diff vazio não exige nada", () => {
    const r = classificar([]);
    expect(r.problemas).toEqual([]);
  });

  it("🔴 não há forma genérica de desligar o guard", () => {
    // Uma variável de ambiente que o desactivasse transformá-lo-ia em
    // decoração: quem tivesse pressa punha-a e seguia. Verifica-se o código,
    // não os comentários — esta nota menciona o padrão para o explicar.
    const fonte = ler("scripts/check-release-note.mjs")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(fonte).not.toMatch(/process\.env\.[A-Z_]*SKIP/);
    expect(fonte).not.toMatch(/SKIP_RELEASE_NOTE/);
  });

  it("não conseguir comparar é falha, não passe silencioso", () => {
    // Um guard que devolve verde quando não sabe é pior do que não existir.
    const fonte = ler("scripts/check-release-note.mjs");
    expect(fonte).toContain("Não foi possível comparar");
    expect(fonte).toMatch(/process\.exit\(1\)/);
  });
});

describe("o CI consegue ver a base", () => {
  const workflow = ler(".github/workflows/quality.yml");

  it("🔴 fetch-depth: 0 — sem isto o guard não pode comparar", () => {
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("o checkout continua a ser o HEAD do autor, não um merge simulado", () => {
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
  });

  it("o guard corre no CI, com a base do PR", () => {
    expect(workflow).toContain("scripts/check-release-note.mjs");
    expect(workflow).toContain("github.event.pull_request.base.sha");
  });
});

describe("uma release, um ficheiro", () => {
  it("cada nota vive no seu próprio ficheiro", () => {
    const ficheiros = fs
      .readdirSync(path.join(RAIZ, "src/release-notes"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts");

    // Uma nota por ficheiro é o que torna «release nova» detectável no diff.
    expect(ficheiros.length).toBe(RELEASE_NOTES.length);
  });

  it("o nome do ficheiro corresponde à key", () => {
    for (const n of RELEASE_NOTES) {
      const esperado = path.join(RAIZ, "src/release-notes", `${n.key}.ts`);
      expect(fs.existsSync(esperado), `falta ${n.key}.ts`).toBe(true);
    }
  });

  it("o processo está escrito onde é lido antes de fechar um PR", () => {
    expect(ler("AGENTS.md").toLowerCase()).toContain("release note");
  });
});

describe("as notas não expõem o interior do sistema", () => {
  it("🔴 sem jargão técnico", () => {
    const proibido = /migration|constraint|\bRLS\b|\bRPC\b|checksum|\bSQL\b|schema|commit|deploy|endpoint/i;
    for (const n of RELEASE_NOTES) {
      expect(proibido.test(`${n.title} ${n.message}`), `${n.key}: jargão técnico`).toBe(false);
    }
  });

  it("são curtas e as chaves são únicas", () => {
    const chaves = RELEASE_NOTES.map((n) => n.key);
    expect(new Set(chaves).size).toBe(chaves.length);
    for (const n of RELEASE_NOTES) {
      expect(n.title.length).toBeLessThanOrEqual(80);
      expect(n.message.length).toBeLessThanOrEqual(400);
    }
  });
});
