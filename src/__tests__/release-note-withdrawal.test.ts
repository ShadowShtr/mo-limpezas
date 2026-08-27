/**
 * Retirada de notas de versão — RN01 a RN12.
 *
 * Uma nota publicada é imutável, e continua a ser. O problema que isto resolve
 * é outro: uma nota pode deixar de ser **verdade**. A #86 anunciou que bastava
 * o nome para criar um colaborador; a alteração foi revertida no mesmo dia, e
 * continuar a mostrar o aviso seria dizer às pessoas que o sistema faz uma
 * coisa que não faz.
 *
 * As duas saídas óbvias são más: apagar a nota destrói o que alguém disse ter
 * lido; mantê-la mente. A retirada é a terceira — um artefacto separado, também
 * imutável, que distingue «existiu no histórico» de «ainda deve ser mostrada».
 *
 * 🔴 Nada aqui depende de `publishedAt` ter passado ou não. `releaseElegivel`
 *    compara `publishedAt` com `max(profileCreatedAt, activatedAt)` e **nunca**
 *    com o relógio: uma nota com data futura é elegível na mesma. Qualquer
 *    raciocínio do género «ainda não podia ter aparecido» é falso, e a solução
 *    não assenta nele.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RELEASE_NOTES } from "@/release-notes";
import { RELEASE_NOTE_WITHDRAWALS, withdrawnKeys } from "@/release-note-withdrawals";
import { releasesPorMostrar } from "@/domain/update-notices/eligibility";
import { classificar } from "../../scripts/check-release-note.mjs";

const ROOT = process.cwd();
const KEY_RETIRADA = "2026-08-26-colaborador-apenas-com-nome";
const FICHEIRO_NOTA = `src/release-notes/${KEY_RETIRADA}.ts`;
const FICHEIRO_RETIRADA = `src/release-note-withdrawals/${KEY_RETIRADA}.ts`;

const ff = (status: string, p: string) => ({ status, path: p });

describe("retirada — a nota original não é tocada", () => {
  it("RN01. a nota retirada continua a existir em código", () => {
    expect(fs.existsSync(path.join(ROOT, FICHEIRO_NOTA))).toBe(true);
    const fonte = fs.readFileSync(path.join(ROOT, FICHEIRO_NOTA), "utf8");
    // O ficheiro não ganhou marca nenhuma de retirada: quem retira é o outro
    // artefacto. Uma flag aqui dentro seria modificar uma nota imutável.
    expect(fonte).not.toMatch(/withdrawn|retirada|revogad/i);
  });

  it("RN02. a key da nota retirada mantém-se no catálogo", () => {
    // 🔴 Continua em `RELEASE_NOTES`. Os registos de leitura apontam para esta
    //    `key`, e tirá-la do catálogo deixaria esses registos a apontar para
    //    coisa nenhuma.
    expect(RELEASE_NOTES.map((n) => n.key)).toContain(KEY_RETIRADA);
  });
});

describe("retirada — deixa de ser oferecida", () => {
  const perfilAntigo = "2020-01-01T00:00:00.000Z";
  const activo = "2020-01-01T00:00:00.000Z";

  it("RN03. uma nota retirada não chega ao ecrã", () => {
    const mostradas = releasesPorMostrar(RELEASE_NOTES, perfilAntigo, new Set(), activo);
    expect(mostradas.map((n) => n.key)).not.toContain(KEY_RETIRADA);
  });

  it("RN03b. e as outras continuam a chegar", () => {
    const mostradas = releasesPorMostrar(RELEASE_NOTES, perfilAntigo, new Set(), activo);
    expect(mostradas.length).toBe(RELEASE_NOTES.length - withdrawnKeys().size);
    expect(mostradas.map((n) => n.key)).toContain("2026-08-26-reposicao-do-acesso");
  });

  it("RN04. retirar não depende de ter sido lida — nem apaga essa informação", () => {
    // Uma nota retirada não aparece a quem já a leu nem a quem nunca a viu. O
    // conjunto de lidas entra e sai intacto: a retirada filtra o que se
    // oferece, não o que ficou registado.
    const lidas = new Set([KEY_RETIRADA]);
    const comLeitura = releasesPorMostrar(RELEASE_NOTES, perfilAntigo, lidas, activo);
    const semLeitura = releasesPorMostrar(RELEASE_NOTES, perfilAntigo, new Set(), activo);
    expect(comLeitura.map((n) => n.key)).not.toContain(KEY_RETIRADA);
    expect(semLeitura.map((n) => n.key)).not.toContain(KEY_RETIRADA);
    expect([...lidas]).toEqual([KEY_RETIRADA]);
  });

  it("RN04b. uma nota com data futura seria elegível — por isso a retirada não usa o relógio", () => {
    // Guarda contra a tentação de justificar uma retirada com «ainda não tinha
    // aparecido». `releaseElegivel` não conhece a hora actual.
    const futura = [{
      key: "9999-01-01-futura", publishedAt: "9999-01-01T00:00:00.000Z",
      kind: "correcao" as const, title: "Futura", message: "Ainda não aconteceu.",
    }];
    const mostradas = releasesPorMostrar(futura, perfilAntigo, new Set(), activo);
    expect(mostradas.map((n) => n.key)).toContain("9999-01-01-futura");
  });
});

describe("retirada — integridade do catálogo", () => {
  it("RN05. toda a retirada aponta para uma nota que existe", () => {
    const chaves = new Set(RELEASE_NOTES.map((n) => n.key));
    for (const w of RELEASE_NOTE_WITHDRAWALS) expect(chaves).toContain(w.key);
  });

  it("RN06. não há duas retiradas para a mesma key", () => {
    const chaves = RELEASE_NOTE_WITHDRAWALS.map((w) => w.key);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("o ficheiro de cada retirada tem o nome da sua key", () => {
    const dir = path.join(ROOT, "src", "release-note-withdrawals");
    const ficheiros = fs.readdirSync(dir).filter((f) => f !== "index.ts");
    expect(ficheiros.sort()).toEqual(
      RELEASE_NOTE_WITHDRAWALS.map((w) => `${w.key}.ts`).sort());
  });

  it("o motivo é interno — não vai para o ecrã", () => {
    const mostradas = releasesPorMostrar(RELEASE_NOTES, "2020-01-01T00:00:00.000Z", new Set());
    const textos = JSON.stringify(mostradas);
    for (const w of RELEASE_NOTE_WITHDRAWALS) {
      expect(textos).not.toContain(w.reason.slice(0, 40));
    }
  });
});

describe("o guard entende retiradas sem abrir excepções", () => {
  it("RN07. modificar uma nota existente continua a ser erro", () => {
    const r = classificar([ff("M", FICHEIRO_NOTA)]);
    expect(r.problemas.join(" ")).toMatch(/imutável/i);
  });

  it("RN08. apagar uma nota existente continua a ser erro", () => {
    const r = classificar([ff("D", FICHEIRO_NOTA)]);
    expect(r.problemas.join(" ")).toMatch(/imutável/i);
  });

  it("RN09. modificar uma retirada é erro", () => {
    const r = classificar([ff("M", FICHEIRO_RETIRADA)]);
    expect(r.problemas.join(" ")).toMatch(/retirada é imutável/i);
  });

  it("RN10. apagar uma retirada é erro", () => {
    const r = classificar([ff("D", FICHEIRO_RETIRADA)]);
    expect(r.problemas.join(" ")).toMatch(/retirada é imutável/i);
  });

  it("RN11. 🔴 uma retirada sozinha não satisfaz uma alteração visível", () => {
    // O ponto todo: retirar um aviso não é anunciar nada. Se o comportamento
    // mudou, quem usa o sistema tem direito a saber o que é verdade agora.
    const r = classificar([
      ff("M", "src/app/(dashboard)/dashboard/colaboradores/page.tsx"),
      ff("A", FICHEIRO_RETIRADA),
    ]);
    expect(r.notasNovas).toEqual([]);
    expect(r.problemas.join(" ")).toMatch(/sem nenhuma release note nova/i);
  });

  it("RN12. uma nota nova verdadeira satisfaz o gate", () => {
    const r = classificar([
      ff("M", "src/app/(dashboard)/dashboard/colaboradores/page.tsx"),
      ff("A", FICHEIRO_RETIRADA),
      ff("A", "src/release-notes/2026-08-26-reposicao-do-acesso.ts"),
    ]);
    expect(r.problemas).toEqual([]);
  });

  it("acrescentar uma retirada nova é permitido", () => {
    const r = classificar([ff("A", FICHEIRO_RETIRADA)]);
    expect(r.problemas).toEqual([]);
  });

  it("o index das retiradas só agrega — mexer nele não é retirar nada", () => {
    const r = classificar([ff("M", "src/release-note-withdrawals/index.ts")]);
    expect(r.problemas).toEqual([]);
  });

  it("não existe variável de ambiente que desligue isto", () => {
    const fonte = fs.readFileSync(path.join(ROOT, "scripts/check-release-note.mjs"), "utf8");
    expect(fonte).not.toMatch(/process\.env\.(SKIP|ALLOW|FORCE|OVERRIDE)/);
  });
});
