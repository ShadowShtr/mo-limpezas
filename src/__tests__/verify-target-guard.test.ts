// ============================================================================
// Guardas de alvo do verificador de `profiles` — correção do procedimento
// ============================================================================
// A primeira versão do verificador recusava correr quando o project ref da
// `--database-url` era igual ao de `NEXT_PUBLIC_SUPABASE_URL`. Mas o
// procedimento de ensaio manda apontar AMBAS as variáveis ao projeto
// descartável — porque o runner de migrations exige que coincidam. Seguindo o
// runbook à letra, o verificador recusava-se a correr contra a própria base de
// ensaio, e os resultados 12/12 e 36/36 eram inalcançáveis.
//
// Havia um segundo defeito, mais silencioso: a condição só disparava quando os
// dois refs eram identificáveis. Uma URL de onde não se conseguisse extrair o
// ref passava sem verificação nenhuma.
//
// A correção separa duas perguntas que estavam confundidas:
//   - qual é a base alvo?      → --database-url
//   - qual é a base proibida?  → --forbid-project-ref (prevalece sobre o env)
//
// Estes testes correm a decisão real (`resolveTargetGuard`), e depois
// confirmam pelo CLI que o script obedece ao veredito antes de qualquer ligação.
// ============================================================================

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  extractDbProjectRef,
  extractPublicProjectRef,
  resolveTargetGuard,
} from "../../scripts/lib/verify-target-guard.mjs";

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "verify-profile-guards.mjs");

const DESCARTAVEL = "descartavel1";
const REAL = "projetoreal1";

const urlDe = (ref: string) =>
  `postgresql://postgres.${ref}@aws-1-eu-central-2.pooler.supabase.com:5432/postgres`;

const base = {
  databaseUrl: urlDe(DESCARTAVEL),
  disposable: true,
  forbidProjectRef: REAL,
  configuredSupabaseUrl: `https://${DESCARTAVEL}.supabase.co`,
};

describe("extração do project ref", () => {
  it("aceita ligação direta e pooler", () => {
    expect(extractDbProjectRef(`postgresql://postgres@db.${REAL}.supabase.co:5432/postgres`)).toBe(REAL);
    expect(extractDbProjectRef(urlDe(REAL))).toBe(REAL);
  });

  it("devolve null para o que não é Supabase", () => {
    expect(extractDbProjectRef("postgresql://user@localhost:5432/db")).toBeNull();
    expect(extractDbProjectRef("não é url")).toBeNull();
    // Um host que apenas *contém* o sufixo não conta.
    expect(
      extractDbProjectRef("postgresql://postgres.x@pooler.supabase.com.evil.com:5432/db"),
    ).toBeNull();
  });

  it("extrai o ref público de NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(extractPublicProjectRef(`https://${REAL}.supabase.co`)).toBe(REAL);
    expect(extractPublicProjectRef(undefined)).toBeNull();
    expect(extractPublicProjectRef("")).toBeNull();
  });
});

describe("resolveTargetGuard — argumentos obrigatórios", () => {
  it("falha sem --database-url", () => {
    const r = resolveTargetGuard({ ...base, databaseUrl: null });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("--database-url");
  });

  it("falha sem confirmação de base descartável", () => {
    const r = resolveTargetGuard({ ...base, disposable: false });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain(
      "--i-know-this-database-is-disposable",
    );
  });
});

describe("resolveTargetGuard — identificação do alvo", () => {
  it("falha se o project ref do alvo não for identificável", () => {
    const r = resolveTargetGuard({
      ...base,
      databaseUrl: "postgresql://user@localhost:5432/db",
    });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/identificar o project ref/i);
  });

  it("não passa em silêncio quando o alvo é desconhecido, mesmo com ref protegido", () => {
    // O defeito antigo: `configuredRef && targetRef && iguais` deixava passar
    // tudo o que não fosse identificável.
    const r = resolveTargetGuard({
      ...base,
      databaseUrl: "postgresql://user@localhost:5432/db",
      forbidProjectRef: REAL,
    });

    expect(r.ok).toBe(false);
  });
});

describe("resolveTargetGuard — projeto protegido", () => {
  it("falha quando o alvo é o projeto proibido pela flag", () => {
    const r = resolveTargetGuard({ ...base, databaseUrl: urlDe(REAL) });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain(REAL);
  });

  it("falha quando não há flag nem NEXT_PUBLIC_SUPABASE_URL", () => {
    const r = resolveTargetGuard({
      ...base,
      forbidProjectRef: null,
      configuredSupabaseUrl: null,
    });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/--forbid-project-ref/);
  });

  it("uma flag vazia ou só espaços não conta como proteção", () => {
    const r = resolveTargetGuard({
      ...base,
      forbidProjectRef: "   ",
      configuredSupabaseUrl: null,
    });

    expect(r.ok).toBe(false);
  });

  it("sem flag, NEXT_PUBLIC_SUPABASE_URL continua a proteger", () => {
    const r = resolveTargetGuard({
      ...base,
      forbidProjectRef: null,
      databaseUrl: urlDe(REAL),
      configuredSupabaseUrl: `https://${REAL}.supabase.co`,
    });

    expect(r.ok).toBe(false);
  });
});

describe("resolveTargetGuard — o cenário do runbook", () => {
  it("a flag explícita prevalece sobre NEXT_PUBLIC_SUPABASE_URL", () => {
    // ESTE é o caso que estava quebrado: durante o ensaio, o env aponta
    // legitimamente para a base descartável (o runner exige que coincida com
    // SUPABASE_DB_URL), e o projeto proibido é o real.
    const r = resolveTargetGuard({
      databaseUrl: urlDe(DESCARTAVEL),
      disposable: true,
      forbidProjectRef: REAL,
      configuredSupabaseUrl: `https://${DESCARTAVEL}.supabase.co`,
    });

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.targetRef).toBe(DESCARTAVEL);
    expect(r.ok === true && r.protectedRef).toBe(REAL);
    expect(r.ok === true && r.protectedSource).toBe("flag");
  });

  it("declara a origem da proteção, para o operador a ver no ecrã", () => {
    const comFlag = resolveTargetGuard(base);
    expect(comFlag.ok === true && comFlag.protectedSource).toBe("flag");

    const semFlag = resolveTargetGuard({
      ...base,
      forbidProjectRef: null,
      configuredSupabaseUrl: `https://${REAL}.supabase.co`,
    });
    expect(semFlag.ok === true && semFlag.protectedSource).toBe("env");
  });
});

// ---------------------------------------------------------------------------
// O script obedece ao veredito — antes de qualquer ligação
// ---------------------------------------------------------------------------

async function correrScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", ...env },
    });
    return { code: 0, saida: stdout + stderr };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, saida: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("CLI — recusa antes de ligar à base", () => {
  const timeout = { timeout: 60_000 };

  it("recusa o projeto protegido, sem sequer tentar ligar", async () => {
    const r = await correrScript([
      "--database-url",
      urlDe(REAL),
      "--forbid-project-ref",
      REAL,
      "--i-know-this-database-is-disposable",
    ]);

    expect(r.code).not.toBe(0);
    expect(r.saida).toContain("é o projeto protegido");
    // Se tivesse tentado ligar, veríamos um erro de rede.
    expect(r.saida).not.toMatch(/ENOTFOUND|ECONNREFUSED|not found/);
  }, timeout);

  it("recusa quando não há projeto protegido declarado", async () => {
    const r = await correrScript([
      "--database-url",
      urlDe(DESCARTAVEL),
      "--i-know-this-database-is-disposable",
    ]);

    expect(r.code).not.toBe(0);
    expect(r.saida).toContain("--forbid-project-ref");
  }, timeout);

  it("recusa um alvo não identificável", async () => {
    const r = await correrScript([
      "--database-url",
      "postgresql://user@localhost:5432/db",
      "--forbid-project-ref",
      REAL,
      "--i-know-this-database-is-disposable",
    ]);

    expect(r.code).not.toBe(0);
    expect(r.saida).toMatch(/identificar o project ref/i);
  }, timeout);

  it("o modo --rehearse-rollback usa exatamente a mesma proteção", async () => {
    const r = await correrScript([
      "--database-url",
      urlDe(REAL),
      "--forbid-project-ref",
      REAL,
      "--i-know-this-database-is-disposable",
      "--rehearse-rollback",
    ]);

    expect(r.code).not.toBe(0);
    expect(r.saida).toContain("é o projeto protegido");
  }, timeout);

  it("com a flag a apontar noutro projeto, passa as guardas e chega à ligação", async () => {
    // O cenário do runbook. Falhar na ligação é a prova de que passou as
    // guardas — a base não existe.
    const r = await correrScript(
      [
        "--database-url",
        urlDe(DESCARTAVEL),
        "--forbid-project-ref",
        REAL,
        "--i-know-this-database-is-disposable",
      ],
      { NEXT_PUBLIC_SUPABASE_URL: `https://${DESCARTAVEL}.supabase.co` },
    );

    expect(r.saida).not.toContain("é o projeto protegido");
    expect(r.saida).toMatch(/ENOTFOUND|ECONNREFUSED|not found|getaddrinfo/i);
  }, timeout);
});

// ---------------------------------------------------------------------------
// Limites desta correção
// ---------------------------------------------------------------------------

describe("limites — nada além do procedimento foi tocado", () => {
  const readNormalized = (p: string) =>
    fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

  it("nenhum project ref real fica versionado", () => {
    // O ref do projeto real não pode entrar no repositório: o runbook usa
    // apenas o marcador, e o script recebe-o por argumento.
    const suspeitos = [
      "docs/PRODUCTION-RUNBOOK.md",
      "scripts/verify-profile-guards.mjs",
      "scripts/lib/verify-target-guard.mjs",
    ];

    for (const rel of suspeitos) {
      const conteudo = readNormalized(rel);

      // Um ref do Supabase é uma sequência longa de letras minúsculas. Aqui
      // não deve existir nenhum literal com esse formato ligado a supabase.co.
      const literais =
        conteudo.match(/https:\/\/[a-z]{15,}\.supabase\.co/g) ?? [];

      expect(literais, `${rel} não pode conter um project ref literal`).toEqual(
        [],
      );
    }
  });

  it("o runbook usa o marcador, não um ref concreto", () => {
    const runbook = readNormalized("docs/PRODUCTION-RUNBOOK.md");

    expect(runbook).toContain("--forbid-project-ref");
    expect(runbook).toContain("<ref-do-projeto-real>");
    expect(runbook).toContain("<ref-descartavel>");
  });

  it("a migration 070 não foi tocada", () => {
    const migration = readNormalized(
      "supabase/migrations/070_guard_profile_managed_fields.sql",
    );

    expect(migration).toContain("fn_guard_profile_managed_fields");
    expect(migration).toContain("PROFILE_MANAGED_FIELD_BLOCKED");
    expect(migration).toContain("BEFORE UPDATE ON public.profiles");
  });
});
