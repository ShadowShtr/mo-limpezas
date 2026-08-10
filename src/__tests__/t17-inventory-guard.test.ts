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
  deadCodeDoors?: {
    frameworkConvention: boolean;
    cliEntrypoint: boolean;
    dynamicImport: boolean;
    allClosed: boolean;
  };
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

describe("T17-B1 — o resíduo removido não volta", () => {
  // A T17-A tinha aqui o oposto: um teste que EXIGIA que o candidato a REMOVER
  // continuasse a existir, porque essa ronda auditava sem remover. A T17-B1
  // removeu-o depois de provar as condições, e manter aquele teste passaria a
  // congelar o lixo no repositório.
  //
  // Substituído pelo que interessa a longo prazo: que o padrão não regresse.
  // Um teste amarrado a um nome de ficheiro protege um ficheiro; um teste
  // amarrado ao padrão protege o repositório.

  it("nenhum ficheiro versionado tem um caminho do Windows por nome", () => {
    // `:` é ilegal em NTFS e o Windows substitui-o por U+F03A, na área de uso
    // privado do Unicode. Um ficheiro cujo NOME contenha um destes caracteres
    // nasceu de um redireccionamento de shell mal escrito (`> C:\Temp\x.log`),
    // não de uma decisão de alguém.
    const AREA_USO_PRIVADO = /[\uE000-\uF8FF]/;
    const residuos = TRACKED.filter((f) => AREA_USO_PRIVADO.test(f));
    expect(
      residuos.map((f) => JSON.stringify(f)),
      "resíduo de redireccionamento do Windows versionado — apagar o ficheiro, "
      + "não o adicionar ao inventário",
    ).toEqual([]);
  });

  it("todo o candidato a remoção tem zero consumidores e uma razão explícita", () => {
    // Continua a valer para qualquer REMOVER futuro. Hoje a lista está vazia,
    // e o teste passa por vacuidade — de propósito: é uma guarda para o
    // próximo, não uma afirmação sobre o presente.
    for (const e of REPORT.files.filter((x) => x.status === "REMOVER")) {
      expect(e.consumers, `${e.path}: tem consumidores, não pode ser REMOVER`).toBe(0);
      expect(e.confidence, `${e.path}: remoção exige confiança alta`).toBe("alta");
      expect(
        e.reason.length,
        `${e.path}: remoção sem razão escrita não é uma decisão`,
      ).toBeGreaterThan(40);
    }
  });
});

describe("T17-B1 — as três portas antes de declarar código morto", () => {
  // Os falsos positivos da T17-A (§3) vinham todos de concluir "morto" a partir
  // de "sem importadores". Estes testes fixam as três portas que a busca por
  // imports não vê, para que nenhuma regressão do classificador as reabra.

  const codigo = REPORT.files.filter((e) => e.deadCodeDoors != null);

  it("o proxy do Next 16 é reconhecido como convenção, não como órfão", () => {
    const proxy = CLASSIFIED.get("src/proxy.ts");
    expect(proxy, "src/proxy.ts deve estar no inventário").toBeDefined();
    expect(proxy!.status, "protege TODAS as rotas por role; não tem importadores por desenho").toBe("MANTER");
    expect(proxy!.deadCodeDoors?.frameworkConvention, "porta 1: convenção do framework").toBe(true);
  });

  it("nenhuma entrada de convenção do framework é dada como morta", () => {
    const convencao = codigo.filter((e) => e.deadCodeDoors!.frameworkConvention);
    expect(convencao.length, "o classificador tem de reconhecer page/layout/route/proxy").toBeGreaterThan(50);
    expect(convencao.filter((e) => e.status === "REMOVER").map((e) => e.path)).toEqual([]);
  });

  it("nenhuma entrada de linha de comandos é dada como morta", () => {
    const cli = codigo.filter((e) => e.deadCodeDoors!.cliEntrypoint);
    expect(cli.length, "os scripts são pontos de entrada, não código sem consumidores").toBeGreaterThan(20);
    expect(cli.filter((e) => e.status === "REMOVER").map((e) => e.path)).toEqual([]);
  });

  it("um REMOVER exige as três portas fechadas", () => {
    for (const e of REPORT.files.filter((x) => x.status === "REMOVER" && x.deadCodeDoors)) {
      expect(
        e.deadCodeDoors!.allClosed,
        `${e.path}: marcado REMOVER com uma porta ainda aberta`,
      ).toBe(true);
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

  it("os scanners de segurança não são confundidos com ameaças", () => {
    // T17-A §3.2: contêm `SUPABASE_SERVICE_ROLE_KEY` porque a PROCURAM.
    // Mencionar ≠ usar.
    for (const p of ["scripts/scan-secrets.mjs", "scripts/audit-security.ts", "scripts/check-env.ts"]) {
      const e = CLASSIFIED.get(p);
      expect(e, `${p} deve estar no inventário`).toBeDefined();
      expect(e!.scriptRisk, `${p}: procura a chave, não a usa`).not.toBe("PRODUCTION_DANGEROUS");
    }
  });

  it("o próprio auditor não se classifica como perigoso", () => {
    // T17-B1: `audit-file-inventory.mjs` contém `SERVICE_ROLE`, `DROP`,
    // `TRUNCATE` e `/rest/v1/` dentro das suas próprias expressões de detecção,
    // e classificava-se `PRODUCTION_DANGEROUS`. Um auditor apanhado pelo
    // critério que aplica é ruído que faz o inventário deixar de ser lido.
    for (const p of ["scripts/audit-file-inventory.mjs", "scripts/audit-codebase.mjs"]) {
      const e = CLASSIFIED.get(p);
      expect(e, `${p} deve estar no inventário`).toBeDefined();
      expect(e!.scriptRisk, `${p}: não constrói cliente nem chama a base`).toBe("SAFE_OFFLINE");
    }
  });

  it("os comparadores offline não são dados como capazes de escrever", () => {
    // T17-A §3.3: mencionam `--apply`/`--execute` dentro de
    // `assertNoWriteFlags`, que existe para as RECUSAR.
    const comparadores = REPORT.files.filter((e) => /scripts\/compare-.*-compat\.ts$/.test(e.path));
    expect(comparadores.length, "os comparadores devem existir").toBeGreaterThan(0);
    for (const c of comparadores) {
      expect(c.scriptRisk, `${c.path}: recusar uma flag não é possuí-la`).toBe("SAFE_OFFLINE");
    }
  });

  it("um script que escreve por HTTP ou SQL conta como escrita", () => {
    // T17-B1: reconhecer só `.insert(` declarava inofensivo o
    // `import-predios.mjs`, que faz POST a `/rest/v1/building_cards` com a
    // chave administrativa. Um falso "seguro" é pior que nenhuma regra.
    expect(CLASSIFIED.get("scripts/import-predios.mjs")?.scriptRisk).toBe("PRODUCTION_DANGEROUS");
    expect(CLASSIFIED.get("scripts/restore-from-history.mjs")?.scriptRisk).toBe("WRITE_CAPABLE");
  });

  it("o arquivo histórico está preservado e marcado como não-vigente", () => {
    const arquivo = REPORT.files.filter((e) => e.category === "doc-historico");
    expect(arquivo.length, "planning/ foi movido para docs/historico/planning/").toBeGreaterThanOrEqual(15);
    for (const a of arquivo) {
      expect(a.status, `${a.path}: histórico preserva-se, não se apaga`).toBe("MANTER");
      expect(a.reason).toMatch(/histórico/i);
    }
    expect(
      TRACKED.filter((f) => f.startsWith("planning/")),
      "a pasta planning/ na raiz deixou de existir",
    ).toEqual([]);
  });

  it("nenhum ficheiro fica classificado ARQUIVAR por decidir", () => {
    // ARQUIVAR significa "por arquivar". Depois da T17-B1 não deve sobrar
    // nenhum: ou foi arquivado (e é MANTER em docs/historico/), ou continua a
    // ser fonte vigente.
    const pendentes = REPORT.files.filter((e) => e.status === "ARQUIVAR");
    expect(pendentes.map((e) => e.path)).toEqual([]);
  });
});
