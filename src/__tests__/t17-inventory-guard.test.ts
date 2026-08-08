// ============================================================================
// T17-A — Guarda do inventário global
// ============================================================================
//
// 🚨 Estático e offline. Lê `git ls-files` e o relatório versionado. Não liga
//    ao Supabase, não lê `.env`, não executa nada do que inventaria.
//
// ----------------------------------------------------------------------------
//
// O que esta guarda faz — e o que deliberadamente NÃO faz.
//
// FAZ: garantir que todo o ficheiro versionado tem classificação. Um ficheiro
// novo que apareça sem passar pelo inventário faz o teste falhar, com a
// instrução de regenerar.
//
// NÃO FAZ: comparar o relatório campo a campo com uma nova execução. Seria
// frágil de forma inútil — o classificador conta ocorrências de padrões, e
// mudar uma linha de código muda contagens sem que nada de estrutural tenha
// mudado. Uma guarda que falha a toda a hora é desligada na primeira semana, e
// aí deixa de guardar seja o que for.
//
// A regeneração é explícita:
//
//     node scripts/audit-file-inventory.mjs --output reports/file-classification.json

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, "reports", "file-classification.json");

interface Entry {
  path: string;
  category: string;
  status: string;
  confidence: string;
  consumers: number;
  action: string;
  reason: string;
  manualDecision?: boolean;
  scriptRisk?: string;
}

interface Report {
  totalFiles: number;
  byStatus: Record<string, number>;
  files: Entry[];
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
}

const REPORT: Report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
const CLASSIFIED = new Map(REPORT.files.map((e) => [e.path, e]));
const TRACKED = trackedFiles();

const REGENERATE =
  "Regenerar com:\n  node scripts/audit-file-inventory.mjs --output reports/file-classification.json";

describe("T17-A — inventário global", () => {
  it("todo o ficheiro versionado está classificado", () => {
    const semClassificacao = TRACKED.filter((f) => !CLASSIFIED.has(f));
    expect(
      semClassificacao,
      `${semClassificacao.length} ficheiro(s) versionado(s) sem classificação.\n${REGENERATE}`,
    ).toEqual([]);
  });

  it("o inventário não classifica ficheiros que já não existem", () => {
    const tracked = new Set(TRACKED);
    const fantasmas = REPORT.files.map((e) => e.path).filter((p) => !tracked.has(p));
    expect(
      fantasmas,
      `${fantasmas.length} ficheiro(s) no inventário já não estão versionados.\n${REGENERATE}`,
    ).toEqual([]);
  });

  it("o total do relatório bate com o que está versionado", () => {
    expect(REPORT.totalFiles, REGENERATE).toBe(TRACKED.length);
  });

  it("todo o estado é um dos seis previstos", () => {
    const validos = ["MANTER", "CENTRALIZAR", "SUBSTITUIR", "REMOVER", "ARQUIVAR", "STANDBY"];
    const invalidos = [...new Set(REPORT.files.map((e) => e.status))].filter((s) => !validos.includes(s));
    expect(invalidos, `estados fora da matriz: ${invalidos.join(", ")}`).toEqual([]);
  });

  it("toda a classificação tem uma razão escrita", () => {
    const semRazao = REPORT.files.filter((e) => !e.reason || e.reason.trim().length < 10);
    expect(
      semRazao.map((e) => e.path),
      "uma classificação sem razão não é uma decisão, é um palpite",
    ).toEqual([]);
  });
});

describe("T17-A — a T17-A não remove nada", () => {
  it("nenhum ficheiro marcado REMOVER foi de facto removido", () => {
    // Esta ronda é de auditoria. A remoção é trabalho da T17-B, e o inventário
    // tem de continuar a apontar o candidato até lá.
    const paraRemover = REPORT.files.filter((e) => e.status === "REMOVER");
    for (const e of paraRemover) {
      expect(
        fs.existsSync(path.join(ROOT, e.path)),
        `${e.path} está marcado REMOVER mas já não existe — a T17-A não remove.`,
      ).toBe(true);
    }
  });

  it("todo o candidato a remoção tem zero consumidores e uma razão explícita", () => {
    for (const e of REPORT.files.filter((x) => x.status === "REMOVER")) {
      expect(e.consumers, `${e.path}: tem consumidores, não pode ser REMOVER`).toBe(0);
      expect(e.confidence, `${e.path}: remoção exige confiança alta`).toBe("alta");
      expect(e.manualDecision, `${e.path}: remoção tem de ser decisão manual`).toBe(true);
    }
  });
});

describe("T17-A — invariantes que o inventário protege", () => {
  it("as migrations nunca são candidatas a remoção", () => {
    const migrations = REPORT.files.filter((e) => e.category === "migration");
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) {
      expect(m.status, `${m.path}: uma migration versionada é histórico do schema`).toBe("MANTER");
    }
  });

  it("o SQL congelado continua em standby, não aplicado", () => {
    const frozen = REPORT.files.filter((e) => e.category === "sql-frozen");
    expect(frozen.length).toBe(2);
    for (const f of frozen) expect(f.status).toBe("STANDBY");
  });

  it("os módulos legacy continuam em standby, nunca MANTER definitivo", () => {
    const legacy = REPORT.files.filter((e) => /legacy-(formulas|reports|dashboard|recurrence)\.ts$/.test(e.path));
    expect(legacy.length).toBe(4);
    for (const l of legacy) {
      expect(l.status, `${l.path}: réplica só para comparação`).toBe("STANDBY");
      expect(l.action).toMatch(/remover depois/i);
    }
  });

  it("os scripts que usam a chave administrativa e escrevem estão assinalados", () => {
    const perigosos = REPORT.files.filter((e) => e.scriptRisk === "PRODUCTION_DANGEROUS");
    expect(perigosos.length).toBeGreaterThan(0);
    for (const p of perigosos) {
      expect(p.status, `${p.path}: script perigoso não pode ficar em MANTER silencioso`).toBe("STANDBY");
    }
  });

  it("o proxy do Next 16 é reconhecido como convenção, não como órfão", () => {
    // Foi um falso positivo real do primeiro classificador: `src/proxy.ts` é o
    // antigo `middleware.ts`, protege todas as rotas por role, e não tem
    // importadores por desenho.
    const proxy = CLASSIFIED.get("src/proxy.ts");
    expect(proxy, "src/proxy.ts deve estar no inventário").toBeDefined();
    expect(proxy!.status).toBe("MANTER");
  });
});
