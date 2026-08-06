// ============================================================================
// GUARDA — o auditor produz um relatório determinístico e não confunde
// testes com risco de produção
// ============================================================================
// Origem: revisão do PR #34 (Task T00 do plano mestre).
//
// Três defeitos concretos que estes testes impedem de voltar:
//
// 1. `generatedAt: new Date().toISOString()` fazia com que duas execuções
//    seguidas, sem nenhuma alteração no repositório, produzissem um diff em
//    `reports/code-audit.json`. Um inventário versionado que muda sozinho
//    deixa de servir como prova.
//
// 2. O relatório contava-se a si próprio: `reports/` entrava no inventário, e
//    como cada execução muda o tamanho do ficheiro que a execução seguinte
//    mede, `textLines` oscilava entre corridas.
//
// 3. Uma chamada a `auth.signUp` dentro de `tenant-isolation-hotfix.test.ts`
//    era classificada como risco de confiança alta — quando esse teste é
//    precisamente a suite a verificar que o registo público está fechado.
//    Depois da Task T03 remover os artefactos perigosos, o gate
//    `--fail-on-high-confidence` ficaria permanentemente vermelho por causa
//    de um teste bom.
//
// Cada execução do auditor cria um programa TypeScript completo (~17s), por
// isso o ficheiro corre-o o número mínimo de vezes (duas, mais uma com flag) e
// partilha os resultados. A chamada é assíncrona de propósito: `execFileSync`
// bloqueava o worker do vitest tempo suficiente para o heartbeat `onTaskUpdate`
// expirar e poluir a corrida com um erro não tratado.
// ============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, "..", "..");
const AUDITOR = path.join(ROOT, "scripts", "audit-codebase.mjs");
const COMMITTED = path.join(ROOT, "reports", "code-audit.json");

/** O git pode materializar o ficheiro com CRLF; a comparação é de conteúdo. */
function normalize(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function runAuditor(extraArgs: string[] = []): Promise<string> {
  const output = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "audit-")),
    "report.json",
  );

  await execFileAsync(
    process.execPath,
    [AUDITOR, "--output", output, ...extraArgs],
    { cwd: ROOT },
  );

  return normalize(fs.readFileSync(output, "utf8"));
}

let primeira = "";
let segunda = "";
let comTimestamp = "";

beforeAll(async () => {
  primeira = await runAuditor();
  segunda = await runAuditor();
  comTimestamp = await runAuditor(["--include-timestamp"]);
}, 300_000);

describe("auditor — determinismo", () => {
  it("duas execuções sem alterações produzem conteúdo idêntico", () => {
    expect(segunda).toBe(primeira);
  });

  it("o relatório não contém timestamp por omissão", () => {
    const report = JSON.parse(primeira);

    expect(report.generatedAt).toBeUndefined();

    // Nenhuma data ISO em campo nenhum, venha de onde vier.
    expect(primeira).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("--include-timestamp junta generatedAt, e só isso", () => {
    const comFlag = JSON.parse(comTimestamp);

    expect(comFlag.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    delete comFlag.generatedAt;

    expect(JSON.stringify(comFlag)).toBe(
      JSON.stringify(JSON.parse(primeira)),
    );
  });

  it("o relatório não se conta a si próprio", () => {
    // `reports/` é saída gerada. Se voltasse ao inventário, `textLines`
    // voltaria a oscilar entre execuções consecutivas.
    expect(primeira).not.toMatch(/"reports\//);
  });

  it("o relatório versionado está em dia com o repositório", () => {
    expect(normalize(fs.readFileSync(COMMITTED, "utf8"))).toBe(primeira);
  });

  it("o relatório versionado não expõe caminhos absolutos nem a máquina local", () => {
    const committed = normalize(fs.readFileSync(COMMITTED, "utf8"));

    expect(committed).not.toMatch(/[A-Za-z]:\\/);
    expect(committed).not.toMatch(/\/Users\//);
    expect(committed).not.toMatch(/\/home\//);
    // Ficheiros ignorados pelo git (dados reais) nunca entram no inventário.
    expect(committed).not.toMatch(/"backups\//);
  });
});

describe("auditor — testes não são risco de produção", () => {
  it("uma chamada signUp num teste fica fora de highConfidence", () => {
    const report = JSON.parse(primeira);

    const emProducao: string[] = report.highConfidence.productionPublicSignupCalls;
    const emTestes: string[] = report.reviewRequired.testSignupCalls;

    // O caso real que originou esta correção.
    expect(emTestes).toContain("src/__tests__/tenant-isolation-hotfix.test.ts");

    const testesEmHighConfidence = [
      ...emProducao,
      ...report.highConfidence.productionAdminClientInClientComponent,
    ].filter(
      (file) => file.includes("/__tests__/") || /\.(test|spec)\./.test(file),
    );

    expect(testesEmHighConfidence).toEqual([]);
  });

  it("o gate --fail-on-high-confidence falha hoje só por causa dos artefactos perigosos", () => {
    const report = JSON.parse(primeira);

    // Enquanto a Task T03 não correr, estes quatro existem e o gate deve
    // continuar vermelho — mas apenas por causa deles.
    expect(report.highConfidence.dangerousArtifacts.length).toBeGreaterThan(0);
    expect(report.highConfidence.productionPublicSignupCalls).toEqual([]);
    expect(report.highConfidence.productionAdminClientInClientComponent).toEqual(
      [],
    );
  });
});
