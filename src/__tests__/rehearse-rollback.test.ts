// ============================================================================
// Ensaio de rollback da migration 070 — integridade e guardas de segurança
// ============================================================================
// Fecha a lacuna que a T04 deixou aberta: existia prova dos 12 cenários com a
// guarda ativa, mas nenhuma prova automatizada de que o rollback a desativa
// sem resíduo e de que a reaplicação a restaura.
//
// O ensaio (`--rehearse-rollback`) EXECUTA o ficheiro da migration tal e qual,
// para não existirem duas cópias do mesmo SQL. Isso torna a integridade do
// ficheiro parte da segurança do ensaio — daí este ficheiro testar
// `validarMigration070` a sério, com entradas construídas, e não só por leitura.
//
// O que continua a NÃO estar provado aqui: que a base recusa a escrita. Isso é
// o próprio script, contra uma base descartável.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  FUNCAO_070,
  TRIGGER_070,
  apenasExecutavel,
  validarMigration070,
} from "../../scripts/lib/migration-070-integrity.mjs";

const ROOT = path.join(__dirname, "..", "..");

const readNormalized = (p: string) =>
  fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const migration070 = readNormalized(
  path.join(ROOT, "supabase/migrations/070_guard_profile_managed_fields.sql"),
);

const script = readNormalized(
  path.join(ROOT, "scripts/verify-profile-guards.mjs"),
);

describe("integridade da migration 070 — a migration real", () => {
  it("passa a validação", () => {
    expect(validarMigration070(migration070)).toEqual({ ok: true });
  });

  it("as secções de rollback e verificação são comentários", () => {
    // É isto que torna seguro executar o ficheiro inteiro. Se deixassem de o
    // ser, o ensaio passaria a largar objetos fora de controlo.
    const executavel = apenasExecutavel(migration070);

    // O `DROP FUNCTION` do rollback tem de continuar comentado — executá-lo
    // largaria a guarda a meio da própria migration.
    expect(executavel).not.toMatch(/DROP FUNCTION/);

    // Já o `DROP TRIGGER IF EXISTS` executável é legítimo e esperado: é a
    // idempotência da migration, imediatamente antes do `CREATE TRIGGER`.
    // Tem de haver exatamente um, e tem de ser esse.
    const dropsDeTrigger = executavel.match(/DROP TRIGGER[^\n;]*/g) ?? [];

    expect(dropsDeTrigger).toEqual([
      `DROP TRIGGER IF EXISTS ${TRIGGER_070} ON public.profiles`,
    ]);

    expect(executavel).toMatch(new RegExp(`CREATE TRIGGER ${TRIGGER_070}`));

    // E o rollback continua documentado, em comentário.
    expect(migration070).toMatch(
      new RegExp(`--\\s*DROP FUNCTION IF EXISTS public\\.${FUNCAO_070}\\(\\);`),
    );
  });
});

describe("integridade da migration 070 — entradas rejeitadas", () => {
  it("rejeita ficheiro em falta", () => {
    expect(validarMigration070(null).ok).toBe(false);
  });

  it("rejeita ficheiro vazio", () => {
    expect(validarMigration070("").ok).toBe(false);
    expect(validarMigration070("   \n\n  ").ok).toBe(false);
  });

  it("rejeita migration sem a função esperada", () => {
    const semFuncao = migration070.replace(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${FUNCAO_070}`),
      "CREATE OR REPLACE FUNCTION public.outra_coisa",
    );

    const veredito = validarMigration070(semFuncao);

    expect(veredito.ok).toBe(false);
    expect(veredito.ok === false && veredito.error).toContain(FUNCAO_070);
  });

  it("rejeita migration sem o trigger esperado", () => {
    const semTrigger = migration070.replace(
      new RegExp(`CREATE TRIGGER ${TRIGGER_070}`),
      "CREATE TRIGGER trg_outro",
    );

    expect(validarMigration070(semTrigger).ok).toBe(false);
  });

  it("rejeita instruções que tocam em dados ou em estrutura de tabelas", () => {
    const perigosas = [
      "ALTER TABLE public.profiles DROP COLUMN hourly_rate;",
      "DROP TABLE public.profiles;",
      "DROP SCHEMA public CASCADE;",
      "TRUNCATE public.profiles;",
      "DELETE FROM public.profiles;",
      "INSERT INTO public.profiles (id) VALUES ('x');",
      "UPDATE profiles SET hourly_rate = 1;",
    ];

    for (const instrucao of perigosas) {
      const adulterada = `${migration070}\n${instrucao}\n`;
      const veredito = validarMigration070(adulterada);

      expect(veredito.ok, `devia rejeitar: ${instrucao}`).toBe(false);
    }
  });

  it("não se deixa enganar por uma instrução perigosa disfarçada de comentário", () => {
    // O contrário do teste acima: comentada, é inofensiva e deve passar.
    const comentada = `${migration070}\n-- DROP TABLE public.profiles;\n`;

    expect(validarMigration070(comentada)).toEqual({ ok: true });
  });
});

describe("script de ensaio — guardas de segurança", () => {
  it("o SQL da 070 é lido do ficheiro, nunca reescrito no script", () => {
    // Duas cópias do mesmo SQL seriam duas fontes de verdade, e o ensaio
    // deixaria de provar o que a migration realmente faz.
    expect(script).toMatch(/070_guard_profile_managed_fields\.sql/);
    expect(script).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
    expect(script).not.toMatch(/RAISE EXCEPTION/);
  });

  it("valida a migration ANTES de ligar à base", () => {
    const validacao = script.indexOf("lerMigration070()");
    const ligacao = script.indexOf("client.connect()");

    expect(validacao).toBeGreaterThan(-1);
    expect(ligacao).toBeGreaterThan(-1);
    expect(validacao).toBeLessThan(ligacao);
  });

  it("o ensaio larga exatamente os objetos documentados no rollback da 070", () => {
    expect(script).toMatch(
      new RegExp(`DROP TRIGGER IF EXISTS \\$\\{TRIGGER_070\\}|DROP TRIGGER IF EXISTS ${TRIGGER_070}`),
    );
    expect(script).toMatch(
      new RegExp(`DROP FUNCTION IF EXISTS public\\.\\$\\{FUNCAO_070\\}|DROP FUNCTION IF EXISTS public\\.${FUNCAO_070}`),
    );
  });

  it("verifica que o rollback é cirúrgico — a 069 tem de sobreviver", () => {
    expect(script).toMatch(/trg_guard_profile_tenant_role/);
    expect(script).toMatch(/não é cirúrgico|nao e cirurgico/);
  });

  it("confirma que a reaplicação recria o trigger", () => {
    expect(script).toMatch(/não recriou o trigger|nao recriou o trigger/);
  });

  it("termina sempre em ROLLBACK, mesmo em erro", () => {
    // O ROLLBACK está num `finally`: uma exceção a meio do ensaio não pode
    // deixar a base com a guarda removida.
    const finallyBlock = script.slice(script.indexOf("} finally {"));

    expect(finallyBlock).toMatch(/ROLLBACK/);
    expect(finallyBlock).toMatch(/client\.end\(\)/);
  });

  it("mantém as guardas contra produção do modo normal", () => {
    expect(script).not.toMatch(/process\.env\.SUPABASE_DB_URL/);
    expect(script).toMatch(/--database-url/);
    expect(script).toMatch(/--i-know-this-database-is-disposable/);
    expect(script).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("avisa que o modo altera temporariamente objetos da base", () => {
    expect(script).toMatch(/ALTERA temporariamente|larga e recria temporariamente/);
  });

  it("o modo só corre com a flag explícita", () => {
    expect(script).toMatch(/args\.includes\("--rehearse-rollback"\)/);
    // Sem a flag, não se lê nem se executa migration nenhuma.
    expect(script).toMatch(/REHEARSE_ROLLBACK \? lerMigration070\(\) : null/);
  });
});

describe("runbook — o procedimento está documentado", () => {
  const runbook = readNormalized(path.join(ROOT, "docs/PRODUCTION-RUNBOOK.md"));

  it("cobre o ensaio da 070 numa base descartável", () => {
    expect(runbook).toMatch(/--rehearse-rollback/);
    expect(runbook).toMatch(/descartável/i);
  });

  it("avisa sobre o .env do ensaio e a confirmação do project ref", () => {
    expect(runbook).toMatch(/--confirm-production/);
    expect(runbook).toMatch(/project ref/i);
  });

  it("proíbe explicitamente correr contra produção", () => {
    expect(runbook).toMatch(/nunca.{0,80}produção|proibido.{0,80}produção/i);
  });
});
