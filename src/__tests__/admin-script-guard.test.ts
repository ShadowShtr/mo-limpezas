// ============================================================================
// T17-B2 — Guarda dos scripts administrativos
// ============================================================================
//
// 🚨 Estático e offline. Testa o módulo de decisão puro e faz análise textual
//    dos scripts versionados. **Não executa nenhum script**, não liga ao
//    Supabase, não lê `.env`.
//
// ----------------------------------------------------------------------------
//
// Duas metades, deliberadamente separadas:
//
//   1. `resolveAdminScriptGuard` — a decisão. É pura, por isso pode ser testada
//      a sério: dá-se-lhe um cenário e verifica-se o veredito.
//
//   2. Os scripts em si — que a decisão é mesmo aplicada. Um guard perfeito não
//      vale nada se um script continuar a construir o seu próprio cliente ao
//      lado. Estes testes existem para que isso volte a ser impossível de
//      acontecer sem alguém reparar.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// O módulo é .mjs puro; os tipos vêm do JSDoc.
import { resolveAdminScriptGuard, parseCommonArgs, FLAGS } from "../../scripts/lib/admin-script-guard.mjs";

const ROOT = process.cwd();

const REF_PROD = "abcdefghijklmnopqrst";
const REF_TESTE = "zyxwvutsrqponmlkjihg";
const EMPRESA = "00000000-0000-0000-0000-000000000001";

interface Veredito {
  ok: boolean;
  error?: string;
  mode?: "dry-run" | "apply";
  targetRef?: string;
  companyId?: string | null;
  targetIsProduction?: boolean;
  productionRefKnown?: boolean;
  warnings?: string[];
}

/**
 * O veredito é uma união discriminada declarada em JSDoc. Num teste, cada
 * `expect(r.error)` obrigaria a estreitar primeiro com `if (r.ok) return` —
 * ruído que esconderia o que cada caso está a afirmar. Aqui a asserção **é** o
 * estreitamento, por isso o invólucro devolve a forma achatada.
 */
const resolve = (entrada: ReturnType<typeof cenario>): Veredito =>
  resolveAdminScriptGuard(entrada as Parameters<typeof resolveAdminScriptGuard>[0]) as Veredito;

function cenario(over: Record<string, unknown> = {}) {
  return {
    script: "exemplo.mjs",
    writes: true,
    supabaseUrl: `https://${REF_TESTE}.supabase.co`,
    serviceKey: "chave-de-teste",
    productionRef: REF_PROD,
    args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.companyId, EMPRESA]),
    ...over,
  };
}

describe("T17-B2 — leitura das flags comuns", () => {
  it("aceita `--flag valor` e `--flag=valor`", () => {
    const a = parseCommonArgs(["--project-ref", "abc", "--company-id=xyz", "--apply"]);
    expect(a.projectRef).toBe("abc");
    expect(a.companyId).toBe("xyz");
    expect(a.apply).toBe(true);
  });

  it("devolve os argumentos próprios do script sem as flags comuns", () => {
    // `restore-servicos.mjs` recebe pasta e data como argumentos posicionais.
    // Se as flags comuns não fossem retiradas, a pasta podia sair "--apply".
    const a = parseCommonArgs(["backups/2026-07-16", "2026-07-01", "--project-ref", "abc", "--apply"]);
    expect(a.rest).toEqual(["backups/2026-07-16", "2026-07-01"]);
  });

  it("sem flags, não assume nada", () => {
    const a = parseCommonArgs([]);
    expect(a.apply).toBe(false);
    expect(a.projectRef).toBeNull();
    expect(a.companyId).toBeNull();
    expect(a.productionAuthorized).toBe(false);
  });
});

describe("T17-B2 — o operador tem de declarar o alvo", () => {
  it("recusa sem --project-ref", () => {
    const r = resolve(cenario({ args: parseCommonArgs([FLAGS.companyId, EMPRESA]) }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--project-ref/);
  });

  it("recusa quando o alvo declarado não é o do ambiente carregado", () => {
    // O caso que interessa: o .env.local aponta para produção e a pessoa julga
    // estar no projeto de testes.
    const r = resolve(cenario({
      supabaseUrl: `https://${REF_PROD}.supabase.co`,
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.companyId, EMPRESA, FLAGS.apply]),
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não corresponde/i);
  });

  it("recusa se não conseguir identificar o projeto", () => {
    const r = resolve(cenario({ supabaseUrl: "https://exemplo.pt" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/project ref/i);
  });
});

describe("T17-B2 — dry-run por omissão", () => {
  it("sem --apply o modo é dry-run, mesmo com tudo o resto correcto", () => {
    const r = resolve(cenario());
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("dry-run");
  });

  it("um script que não escreve nunca precisa de --company-id", () => {
    const r = resolve(cenario({
      writes: false,
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE]),
    }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("dry-run");
  });
});

describe("T17-B2 — produção é recusada por omissão", () => {
  it("recusa escrever no projeto de produção sem autorização explícita", () => {
    const r = resolve(cenario({
      supabaseUrl: `https://${REF_PROD}.supabase.co`,
      args: parseCommonArgs([FLAGS.projectRef, REF_PROD, FLAGS.companyId, EMPRESA, FLAGS.apply]),
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PRODUÇÃO/);
    expect(r.error).toMatch(/REGRA ZERO/);
  });

  it("🔴 trata um alvo desconhecido como produção", () => {
    // A regra que mais interessa. Um guard que só protege quando está bem
    // configurado não protege nada no dia em que alguém se esquece de o
    // configurar — e é sempre nesse dia que o incidente acontece.
    const r = resolve(cenario({
      productionRef: undefined,
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.companyId, EMPRESA, FLAGS.apply]),
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/desconhecida|PRODUÇÃO/);
  });

  it("deixa passar com autorização explícita, e continua a assinalar produção", () => {
    const r = resolve(cenario({
      supabaseUrl: `https://${REF_PROD}.supabase.co`,
      args: parseCommonArgs([
        FLAGS.projectRef, REF_PROD, FLAGS.companyId, EMPRESA, FLAGS.apply, FLAGS.production,
      ]),
    }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("apply");
    expect(r.targetIsProduction).toBe(true);
  });

  it("avisa quando não sabe qual é o projeto de produção", () => {
    const r = resolve(cenario({ productionRef: undefined }));
    expect(r.ok).toBe(true);
    expect((r.warnings ?? []).join(" ")).toMatch(/MO_PRODUCTION_PROJECT_REF/);
  });
});

describe("T17-B2 — company_id obrigatório para escrever", () => {
  it("recusa escrever sem --company-id", () => {
    const r = resolve(cenario({
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.apply]),
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/company-id/);
    expect(r.error).toMatch(/RLS/);
  });

  it("recusa um company_id que não é UUID", () => {
    const r = resolve(cenario({
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.companyId, "empresa-1", FLAGS.apply]),
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/UUID/);
  });

  it("aceita a escrita quando tudo está declarado", () => {
    const r = resolve(cenario({
      args: parseCommonArgs([FLAGS.projectRef, REF_TESTE, FLAGS.companyId, EMPRESA, FLAGS.apply]),
    }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("apply");
    expect(r.companyId).toBe(EMPRESA);
    expect(r.targetIsProduction).toBe(false);
  });
});

// ─── Que os scripts usam mesmo a guarda ─────────────────────────────────────

function tracked(prefixo: string): string[] {
  return execFileSync("git", ["ls-files", "-z", prefixo], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
}

const SCRIPTS_ACTIVOS = tracked("scripts")
  .filter((f) => /\.(mjs|ts)$/.test(f))
  .filter((f) => !f.startsWith("scripts/historico/"))
  .filter((f) => !f.startsWith("scripts/lib/"));

const ler = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/**
 * O ficheiro sem comentários nem literais de expressão regular.
 *
 * A primeira versão destes testes voltou a cair na armadilha que a T17-A
 * registou três vezes e a T17-B1 mais duas: procurar padrões no texto acusa os
 * ficheiros que *descrevem* esses padrões. `audit-file-inventory.mjs` e
 * `scan-secrets.mjs` apareceram como "escrevem com a chave administrativa"
 * porque procuram a chave; e o próprio selo de arquivo apareceu como "tem
 * escapatória" porque **explica** que a flag `--force` existia.
 *
 * Simplificado de propósito face ao classificador: aqui só é preciso separar
 * código de prosa.
 */
function codigoDe(f: string): string {
  return ler(f)
    .replace(/\/\*[\s\S]*?\*\//g, " ")        // comentários de bloco
    .replace(/^[ \t]*\/\/.*$/gm, " ")          // comentários de linha
    .replace(/(^|[=(,:;[!&|?{}])\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuyd]*/g, "$1 ");
}

/** Consegue mesmo falar com a base, por oposição a mencioná-la? */
function constroiCliente(f: string): boolean {
  const c = codigoDe(f);
  return /createClient\s*\(|openAdminDb\s*\(|from\s+["']@supabase\//.test(c)
    || /\/rest\/v1\//.test(c);
}

describe("T17-B2 — a guarda é mesmo aplicada", () => {
  it("nenhum script activo tem o seu próprio parser de .env.local", () => {
    // Eram sete. Cada um com regras ligeiramente diferentes, e nenhum a dizer
    // para onde apontava.
    const proprios = SCRIPTS_ACTIVOS.filter((f) =>
      /readFileSync\(\s*["'`]\.env\.local/.test(ler(f)) || /\bconfig\(\s*\{\s*path/.test(ler(f)));
    expect(proprios, "usar loadEnvFile() de scripts/lib/admin-db.mjs").toEqual([]);
  });

  it("todo o script que escreve com a chave administrativa passa por openAdminDb", () => {
    const escritores = SCRIPTS_ACTIVOS.filter((f) => {
      if (!constroiCliente(f)) return false;    // scanners e ferramentas offline saem aqui
      const s = codigoDe(f);
      const usaChave = /SUPABASE_SERVICE_ROLE_KEY|openAdminDb/.test(s);
      const escreve = /\.(insert|update|upsert|delete)\s*\(/.test(s)
        || /method:\s*["'](POST|PATCH|PUT|DELETE)["']/i.test(s)
        || /auth\.admin\.(createUser|deleteUser|updateUserById)/.test(s);
      return usaChave && escreve;
    });
    const semGuarda = escritores.filter((f) => !/openAdminDb/.test(ler(f)));
    expect(semGuarda, "escrever com a chave administrativa exige a guarda comum").toEqual([]);
  });

  it("nenhum script activo continua a decidir sozinho o --apply", () => {
    // O modo passou a ser decidido pelo guard. Um `process.argv.includes("--apply")`
    // à parte significa que há um segundo caminho de escrita, fora da guarda.
    const proprios = SCRIPTS_ACTIVOS.filter((f) =>
      /process\.argv[\s\S]{0,40}["']--apply["']/.test(ler(f)));
    expect(proprios).toEqual([]);
  });

  it("nenhum script imprime uma password", () => {
    // `create-admins` e `create-colaborador` imprimiam a password no ecrã, o
    // que a punha no histórico da shell.
    const imprimem = SCRIPTS_ACTIVOS.filter((f) =>
      /console\.log\([^)]*\$\{\s*PASSWORD\s*\}|Password:\s*\$\{/.test(ler(f)));
    expect(imprimem).toEqual([]);
  });
});

describe("T17-B2 — os scripts arquivados recusam-se a correr", () => {
  const ARQUIVADOS = tracked("scripts/historico").filter((f) => f.endsWith(".mjs"));

  it("os 4 decididos estão arquivados, não apagados", () => {
    const esperados = ["reset-operacao", "migrate-real-data", "import-fluxo-junho", "import-pdf-jun26"];
    for (const nome of esperados) {
      expect(
        ARQUIVADOS.includes(`scripts/historico/${nome}.mjs`),
        `${nome} tem de continuar versionado, para auditoria`,
      ).toBe(true);
    }
  });

  it("cada um recusa antes de qualquer trabalho, e sem escapatória", () => {
    for (const f of ARQUIVADOS) {
      const s = ler(f);
      expect(s, `${f}: falta o selo de arquivo`).toMatch(/ARQUIVADO — NÃO EXECUTAR/);

      // A recusa tem de ser a PRIMEIRA instrução executável do corpo do módulo.
      // Se vier depois de uma leitura de ficheiro ou de uma consulta, já é
      // tarde. (Os `import` são içados, mas não têm efeitos sobre dados.)
      const semComentarios = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const primeiraInstrucao = semComentarios
        .split("\n").map((l) => l.trim()).filter(Boolean)
        .find((l) => !l.startsWith("import "));
      expect(primeiraInstrucao, `${f}: a recusa não é a primeira coisa a correr`).toMatch(/^console\.error\(/);

      expect(s, `${f}: a recusa tem de terminar o processo`).toMatch(/process\.exit\(1\)/);

      // A escapatória procura-se no CÓDIGO. O selo explica, em prosa, que a
      // flag `--force` deste importador duplicava movimentos — descrever o
      // perigo não é abrir uma porta para ele.
      const codigo = codigoDe(f);
      const antesDoExit = codigo.slice(0, codigo.indexOf("process.exit(1)"));
      expect(
        /--force|--i-know|process\.env\.\w*(FORCE|ALLOW|OVERRIDE)/.test(antesDoExit),
        `${f}: a recusa não pode ter escapatória`,
      ).toBe(false);
    }
  });

  it("nenhum script activo importa um script arquivado", () => {
    // Um `import` a sério, não a palavra "historico" — `audit-file-inventory.mjs`
    // fala de `docs/historico/` porque classifica esse directório.
    const importam = SCRIPTS_ACTIVOS.filter((f) =>
      /(?:from|import|require)\s*\(?\s*["'][^"']*scripts\/historico\//.test(codigoDe(f))
      || /(?:from|import)\s+["'][^"']*\.\/historico\//.test(codigoDe(f)));
    expect(importam).toEqual([]);
  });
});
