// ============================================================================
// GUARDA — os documentos canónicos existem e a hierarquia continua íntegra
// ============================================================================
// Origem: Task T01 do plano mestre (docs/PLANO-MESTRE.md, secção 22).
//
// O problema que este teste previne não é técnico, é documental: o repositório
// acumulou documentos que se contradizem (migration "pendente" num sítio e
// "aplicada" noutro, instruções antigas mantidas depois de proibidas). A
// correção foi criar documentos canónicos com precedência explícita. Este
// teste falha se algum deles desaparecer ou perder a sua âncora — para que a
// hierarquia não se dissolva outra vez por acumulação.
//
// O teste verifica ESTRUTURA (o documento existe e cobre o assunto de que é
// dono), nunca redação. Não impede reescrever nem melhorar os documentos.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(ROOT, relative));
}

describe("documentos canónicos — Task T01", () => {
  it("os quatro documentos de regras ativas existem", () => {
    const required = [
      "AGENTS.md",
      "docs/PRODUCTION-RUNBOOK.md",
      "docs/ARCHITECTURE.md",
      "docs/ENGINEERING-STANDARD.md",
    ];

    const missing = required.filter((relative) => !exists(relative));

    expect(missing).toEqual([]);
  });

  it("docs/README.md é o índice e declara a ordem de precedência", () => {
    const index = read("docs/README.md");

    expect(index).toMatch(/precedência/i);

    for (const target of [
      "../AGENTS.md",
      "PRODUCTION-RUNBOOK.md",
      "ARCHITECTURE.md",
      "ENGINEERING-STANDARD.md",
      "PLANO-MESTRE.md",
    ]) {
      expect(index, `docs/README.md deve indexar ${target}`).toContain(target);
    }
  });

  it("o padrão de engenharia cobre os assuntos de que é dono", () => {
    const standard = read("docs/ENGINEERING-STANDARD.md");

    for (const subject of [
      "Server Actions",
      "Concorrência",
      "Datas",
      "Cache e Realtime",
      "Limpeza",
      "Testes",
      "Definition of Done",
    ]) {
      expect(standard, `falta a secção "${subject}"`).toContain(subject);
    }

    // A Definition of Done tem de ser executável, não uma intenção.
    for (const command of [
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
    ]) {
      expect(standard, `Definition of Done deve incluir ${command}`).toContain(
        command,
      );
    }
  });

  it("a arquitetura descreve o fluxo completo de uma mutação", () => {
    const architecture = read("docs/ARCHITECTURE.md");

    for (const step of [
      "Server Action",
      "Caso de uso",
      "RPC transacional",
      "Outbox",
      "Snapshot autoritativo",
      "Realtime",
    ]) {
      expect(architecture, `o fluxo deve passar por "${step}"`).toContain(step);
    }
  });

  it("os comandos da Definition of Done existem em package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const scripts: Record<string, string> = pkg.scripts ?? {};

    for (const name of ["typecheck", "lint", "test", "build"]) {
      expect(scripts[name], `falta o script "${name}"`).toBeTruthy();
    }
  });

  it("o template de PR existe e exige validação e rollback", () => {
    expect(exists(".github/pull_request_template.md")).toBe(true);

    const template = read(".github/pull_request_template.md");

    for (const section of [
      "## Problema",
      "## Removido",
      "## Standby",
      "## Validação",
      "## Riscos",
      "## Rollback",
    ]) {
      expect(template, `falta a secção "${section}"`).toContain(section);
    }

    expect(template).toContain("REGRA ZERO");
  });

  it("CLAUDE.md remete para os documentos canónicos em vez de os substituir", () => {
    const claude = read("CLAUDE.md");

    expect(claude).toContain("docs/ENGINEERING-STANDARD.md");
    expect(claude).toContain("docs/ARCHITECTURE.md");
    expect(claude).toContain("docs/README.md");
  });

  it("o plano mestre está no repositório com as tasks T00–T19", () => {
    expect(exists("docs/PLANO-MESTRE.md")).toBe(true);

    const plan = read("docs/PLANO-MESTRE.md");

    for (const task of ["T00", "T03", "T09", "T19"]) {
      expect(plan, `o plano deve conter a task ${task}`).toContain(task);
    }
  });

  it("o inventário do auditor está documentado e é reproduzível", () => {
    expect(exists("docs/code-audit/README.md")).toBe(true);
    expect(exists("scripts/audit-codebase.mjs")).toBe(true);

    const pkg = JSON.parse(read("package.json"));
    const scripts: Record<string, string> = pkg.scripts ?? {};

    expect(scripts["audit:code"]).toContain("audit-codebase.mjs");
  });
});
