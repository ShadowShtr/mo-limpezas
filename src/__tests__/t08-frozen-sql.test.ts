// ============================================================================
// SQL CONGELADO DA T08 — GUARDAS ESTÁTICAS
// ============================================================================
// O SQL da T08 não pode ser aplicado enquanto o incidente de credenciais
// estiver aberto e a base descartável não existir. Estes testes verificam que
// isso é uma propriedade ESTRUTURAL e não uma questão de alguém se lembrar:
//
//   · o ficheiro está fora de `supabase/migrations/`;
//   · o runner de migrations lê exclusivamente essa pasta;
//   · a migration 070 continua intocada e a T08 não lhe toca.
//
// Verificam também as invariantes do próprio SQL: unicidade por empresa,
// índice parcial, rollback coerente, nada destrutivo e nada inseguro.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const FROZEN_DIR = path.join(ROOT, "supabase", "frozen");
const FROZEN_SQL = path.join(FROZEN_DIR, "T08_occurrence_identity.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

const sql = fs.readFileSync(FROZEN_SQL, "utf8");

/** SQL sem as linhas comentadas — o que realmente correria. */
const executavel = sql
  .split("\n")
  .filter((linha) => !linha.trimStart().startsWith("--"))
  .join("\n");

// ─── não pode ser aplicado por engano ───────────────────────────────────────

describe("o SQL da T08 é inaplicável pelo runner", () => {
  it("está em supabase/frozen/, não em supabase/migrations/", () => {
    expect(fs.existsSync(FROZEN_SQL)).toBe(true);
    const emMigrations = fs.readdirSync(MIGRATIONS_DIR);
    expect(emMigrations.some((f) => f.toLowerCase().includes("occurrence"))).toBe(false);
    expect(emMigrations.some((f) => f.startsWith("T08") || f.includes("t08"))).toBe(false);
  });

  it("o runner de migrations lê exclusivamente supabase/migrations", () => {
    const runner = fs.readFileSync(path.join(ROOT, "scripts", "run-migrations.mjs"), "utf8");
    expect(runner).toMatch(/MIGRATIONS_DIR\s*=\s*join\(ROOT,\s*"supabase",\s*"migrations"\)/);
    // A única pasta que o runner alguma vez percorre é a das migrations.
    expect(runner).not.toMatch(/join\(ROOT,\s*"supabase",\s*"frozen"\)/);
    expect(runner).not.toMatch(/readdirSync\((?!MIGRATIONS_DIR)/);
  });

  it("nenhum ficheiro do projeto lê a pasta congelada", () => {
    const dirs = [path.join(ROOT, "scripts"), path.join(ROOT, "scripts", "lib")];
    for (const dir of dirs) {
      for (const nome of fs.readdirSync(dir)) {
        const caminho = path.join(dir, nome);
        if (!fs.statSync(caminho).isFile()) continue;
        const conteudo = fs.readFileSync(caminho, "utf8");
        // Referir o caminho em documentação é aceitável; abri-lo não.
        expect(conteudo, caminho).not.toMatch(/(readFile|readdir|glob|exec)\w*\([^)]*frozen/i);
      }
    }
  });

  it("declara em texto que não é uma migration", () => {
    expect(sql).toMatch(/NÃO É UMA MIGRATION/);
    expect(sql).toMatch(/autorização explícita e separada/i);
  });

  it("não toca na migration 070", () => {
    expect(sql).not.toMatch(/\b070\b.*ALTER|ALTER.*\b070\b/);
    expect(executavel).not.toMatch(/profile_managed_fields/);
  });
});

// ─── a garantia de unicidade ────────────────────────────────────────────────

describe("índice de identidade", () => {
  it("é único", () => {
    expect(executavel).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS services_occurrence_identity_uniq/);
  });

  it("inclui company_id — a unicidade é por empresa", () => {
    expect(executavel).toMatch(
      /ON public\.services \(company_id, contract_id, occurrence_date\)/,
    );
  });

  it("é parcial, para não bloquear serviços avulsos nem linhas por preencher", () => {
    expect(executavel).toMatch(
      /WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL/,
    );
  });

  it("a coluna é DATE e nullable (não quebra linhas existentes)", () => {
    expect(executavel).toMatch(/ADD COLUMN IF NOT EXISTS occurrence_date DATE;/);
    expect(executavel).not.toMatch(/occurrence_date DATE NOT NULL/);
  });

  it("documenta a coluna e o índice", () => {
    expect(executavel).toMatch(/COMMENT ON COLUMN public\.services\.occurrence_date/);
    expect(executavel).toMatch(/COMMENT ON INDEX public\.services_occurrence_identity_uniq/);
  });

  it("o ON CONFLICT documentado repete o predicado do índice parcial", () => {
    // Sem repetir o predicado, o PostgreSQL não consegue inferir o índice
    // parcial e o ON CONFLICT falha.
    const inicio = sql.indexOf("-- INSERT INTO public.services");
    expect(inicio).toBeGreaterThan(0);
    const bloco = sql.slice(inicio, sql.indexOf("PASSO 6"));
    expect(bloco).toMatch(/ON CONFLICT \(company_id, contract_id, occurrence_date\)/);
    expect(bloco).toMatch(/WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL/);
    expect(bloco).toMatch(/DO NOTHING/);
    // `DO UPDATE` sobrescreveria em silêncio uma edição humana.
    expect(bloco).not.toMatch(/DO UPDATE/);
  });
});

// ─── backfill ───────────────────────────────────────────────────────────────

describe("backfill", () => {
  it("converte explicitamente para Europe/Lisbon", () => {
    expect(executavel).toMatch(/AT TIME ZONE 'Europe\/Lisbon'/);
  });

  it("nunca faz scheduled_start::date sem fuso", () => {
    expect(executavel).not.toMatch(/scheduled_start::date/);
  });

  it("só preenche o caso inequívoco", () => {
    expect(executavel).toMatch(/is_exception = FALSE/);
    expect(executavel).toMatch(/occurrence_date IS NULL/);
    expect(executavel).toMatch(/NOT EXISTS/); // exclui dias com mais do que um serviço
  });

  it("só escreve na coluna nova", () => {
    const updates = executavel.match(/UPDATE public\.\w+/g) ?? [];
    expect(updates).toEqual(["UPDATE public.services"]);
    expect(executavel).toMatch(/SET occurrence_date = /);
    // Nenhum outro campo de negócio é tocado.
    expect(executavel).not.toMatch(/SET\s+(status|scheduled_start|calculated_value)/);
  });
});

// ─── segurança ──────────────────────────────────────────────────────────────

describe("segurança do SQL", () => {
  it("não cria funções SECURITY DEFINER", () => {
    expect(executavel).not.toMatch(/SECURITY DEFINER/i);
  });

  it("não concede privilégios a anon nem a authenticated", () => {
    expect(executavel).not.toMatch(/GRANT[\s\S]*\b(anon|authenticated|public)\b/i);
  });

  it("não altera RLS", () => {
    expect(executavel).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i);
  });

  it("não contém nada destrutivo na parte executável", () => {
    for (const perigo of [
      /DELETE\s+FROM/i, /TRUNCATE/i, /DROP\s+TABLE/i,
      /DROP\s+SCHEMA/i, /ALTER\s+TABLE[\s\S]*DROP\s+COLUMN/i,
    ]) {
      expect(executavel, `padrão perigoso: ${perigo}`).not.toMatch(perigo);
    }
  });

  it("o rollback existe, mas só como comentário", () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS public\.services_occurrence_identity_uniq/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS occurrence_date/);
    // As duas linhas destrutivas do rollback estão comentadas.
    expect(executavel).not.toMatch(/DROP INDEX/);
    expect(executavel).not.toMatch(/DROP COLUMN/);
  });

  it("os passos executáveis são transacionais e equilibrados", () => {
    const begins = (executavel.match(/^BEGIN;/gm) ?? []).length;
    const commits = (executavel.match(/^COMMIT;/gm) ?? []).length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(commits);
  });

  it("avisa sobre o índice CONCURRENTLY fora de transação", () => {
    expect(sql).toMatch(/CONCURRENTLY/);
    expect(sql).toMatch(/não pode correr dentro de BEGIN\/COMMIT/);
  });

  it("inclui consultas de validação e de deteção de duplicados", () => {
    expect(sql).toMatch(/HAVING count\(\*\) > 1/);
    expect(sql).toMatch(/PASSO 6 — VALIDAÇÃO/);
  });
});
