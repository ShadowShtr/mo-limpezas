// ============================================================================
// GUARD — alteração visível exige nota de versão
// ============================================================================
// Uma alteração que muda o que as pessoas veem, sem uma linha a dizer o que
// mudou, é uma alteração que ninguém sabe que aconteceu. Quem usa o sistema
// descobre pela diferença, e quem dá apoio não tem como explicar.
//
// 🔴 Offline e sem git, como o `financeiro-v2-write-budget`: o CI faz checkout
//    do SHA com profundidade 1 e o ramo base não existe. Um guard que dependa
//    de `git diff` passa localmente e nunca corre onde interessa.
//
// A verificação aqui é estrutural: as notas existem, são consistentes, e o
// processo está documentado onde é lido.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RELEASE_NOTES } from "@/release-notes";

const RAIZ = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

describe("a pasta de notas de versão existe e é a fonte", () => {
  it("src/release-notes está versionada", () => {
    expect(fs.existsSync(path.join(RAIZ, "src/release-notes/index.ts"))).toBe(true);
  });

  it("há pelo menos uma nota", () => {
    // Zero notas com o sistema activo significaria que nada foi comunicado.
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
  });

  it("as chaves seguem o formato data-descrição", () => {
    // Torna a ordem legível no diff e evita colisões acidentais.
    for (const n of RELEASE_NOTES) {
      expect(n.key, `${n.key} não começa por uma data ISO`).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    }
  });
});

describe("🔴 USER_VISIBLE_CHANGE_WITHOUT_RELEASE_NOTE", () => {
  /**
   * As áreas cuja alteração é visível para quem usa o sistema. Mexer aqui sem
   * acrescentar uma nota é o que este guard existe para tornar visível na
   * revisão.
   */
  const AREAS_VISIVEIS = [
    "src/app",
    "src/components",
  ];

  /**
   * Excluídas de propósito — alterar isto não muda nada no ecrã:
   *   · testes, relatórios e documentação;
   *   · infraestrutura interna sem superfície de utilizador.
   */
  const EXCLUIDAS = [
    "src/__tests__",
    "docs",
    "reports",
  ];

  it("as áreas visíveis estão declaradas e existem", () => {
    for (const a of AREAS_VISIVEIS) {
      expect(fs.existsSync(path.join(RAIZ, a)), `${a} não existe`).toBe(true);
    }
  });

  it("as exclusões são explícitas, não um escape genérico", () => {
    // Uma variável de ambiente que desliga o guard transformá-lo-ia em
    // decoração: quem tivesse pressa punha-a e seguia. Verifica-se o código,
    // não os comentários — esta própria nota menciona o padrão para o explicar.
    const fonte = ler("src/__tests__/release-note-guard.test.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    expect(fonte).not.toMatch(/process\.env\.[A-Z_]*SKIP/);
    expect(EXCLUIDAS.length).toBeLessThan(6);
  });

  it("o processo está escrito onde é lido antes de fechar um PR", () => {
    // Uma regra que só vive num teste é uma regra que se descobre a falhar.
    const agents = ler("AGENTS.md");
    expect(agents.toLowerCase()).toContain("release note");
  });
});

describe("as notas não expõem o interior do sistema", () => {
  it("🔴 sem jargão técnico", () => {
    const proibido = /migration|constraint|\bRLS\b|\bRPC\b|checksum|\bSQL\b|schema|commit|deploy|endpoint/i;
    for (const n of RELEASE_NOTES) {
      expect(proibido.test(`${n.title} ${n.message}`), `${n.key}: jargão técnico`).toBe(false);
    }
  });

  it("são curtas — uma ou duas frases", () => {
    for (const n of RELEASE_NOTES) {
      expect(n.title.length, `${n.key}: título longo`).toBeLessThanOrEqual(80);
      expect(n.message.length, `${n.key}: mensagem longa`).toBeLessThanOrEqual(400);
    }
  });
});
