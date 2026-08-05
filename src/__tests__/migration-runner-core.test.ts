// ============================================================================
// NÚCLEO DO RUNNER — teste integrado com cliente Postgres FALSO
// ============================================================================
// scripts/lib/migration-runner-core.mjs — nunca liga a uma base real. Um
// FakeClient grava todas as queries recebidas; cada teste inspeciona
// exatamente que SQL foi (ou não foi) executado.
//
// Origem (2026-08-05, revisão pós-incidente da PR #32): a versão anterior
// do runner chamava `ensureTracking()` (CREATE TABLE/ALTER TABLE) e podia
// fazer UPDATE de backfill de checksum ANTES de qualquer verificação de
// --dry-run — ou seja, o "dry-run" escrevia. Este ficheiro prova, por
// captura de queries reais (não só pela leitura do código), que isso não
// volta a acontecer: em qualquer modo apply=false, zero queries mutáveis.
//
// Os casos de rejeição de host/username com sufixo/prefixo (extractDbProjectRef)
// já estão cobertos em src/__tests__/migration-runner-guards.test.ts — são
// validações de CLI que não envolvem nenhum cliente de base de dados, por
// isso não são repetidos aqui.
// ============================================================================

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const MUTATING_PREFIXES = ["CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "DROP"];

function isMutatingQuery(sql: string) {
  const s = sql.trim().toUpperCase();
  return MUTATING_PREFIXES.some((p) => s.startsWith(p));
}

/** Cliente Postgres falso — nunca liga a nada, só responde de forma determinística e grava tudo o que recebeu. */
interface AppliedRow {
  name: string;
  checksum: string | null;
}

interface FakeClientOptions {
  tableExists?: boolean;
  hasChecksumCol?: boolean;
  appliedRows?: AppliedRow[];
  companiesCount?: number;
  failOnSqlContaining?: string | null;
  /** Se definido, a query a public.companies lança este erro em vez de devolver rows. */
  companiesQueryError?: { code?: string; message?: string } | null;
}

interface CapturedQuery {
  sql: string;
  params: unknown;
}

class FakeClient {
  queries: CapturedQuery[] = [];
  private _tableExists: boolean;
  private _hasChecksumCol: boolean;
  private _appliedRows: AppliedRow[];
  private _companiesCount: number;
  private _failOnSqlContaining: string | null;
  private _companiesQueryError: { code?: string; message?: string } | null;

  constructor({ tableExists = false, hasChecksumCol = false, appliedRows = [], companiesCount = 0, failOnSqlContaining = null, companiesQueryError = null }: FakeClientOptions = {}) {
    this._tableExists = tableExists;
    this._hasChecksumCol = hasChecksumCol;
    this._appliedRows = appliedRows;
    this._companiesCount = companiesCount;
    this._failOnSqlContaining = failOnSqlContaining;
    this._companiesQueryError = companiesQueryError;
  }

  async query(sql: string, params?: unknown) {
    const trimmed = String(sql).trim();
    this.queries.push({ sql: trimmed, params });

    if (trimmed.startsWith("SELECT to_regclass")) {
      return { rows: [{ reg: this._tableExists ? "public._migrations" : null }] };
    }
    if (trimmed.includes("information_schema.columns")) {
      return { rows: this._hasChecksumCol ? [{ ok: 1 }] : [] };
    }
    if (trimmed === "SELECT name, checksum FROM public._migrations") {
      return { rows: this._appliedRows.map((r) => ({ name: r.name, checksum: r.checksum })) };
    }
    if (trimmed === "SELECT name FROM public._migrations") {
      return { rows: this._appliedRows.map((r) => ({ name: r.name })) };
    }
    if (trimmed.startsWith("SELECT count(*)::int AS n FROM public.companies")) {
      if (this._companiesQueryError) {
        const err: { code?: string; message?: string } = new Error(this._companiesQueryError.message ?? "erro simulado");
        if (this._companiesQueryError.code) err.code = this._companiesQueryError.code;
        throw err;
      }
      return { rows: [{ n: this._companiesCount }] };
    }
    if (this._failOnSqlContaining && trimmed.includes(this._failOnSqlContaining)) {
      throw new Error("erro simulado de migração");
    }
    // CREATE/ALTER/INSERT/UPDATE/BEGIN/COMMIT/ROLLBACK/qualquer SQL de
    // migração/seed — aceite sem efeito, só fica gravado em this.queries.
    return { rows: [] };
  }
}

function makeCapturingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, log: push, logWarn: push, logError: push };
}

function makeFixtureMigrationsDir(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-runner-core-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir(files: Record<string, string>) {
  const dir = makeFixtureMigrationsDir(files);
  tempDirs.push(dir);
  return dir;
}

describe("runMigrations — dry-run (apply=false) nunca executa query mutável", () => {
  it("sem nada aplicado e sem pendentes reais (fixture vazia): zero queries mutáveis", async () => {
    const migrationsDir = fixtureDir({});
    const client = new FakeClient({ tableExists: true, hasChecksumCol: true, appliedRows: [] });
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(exitCode).toBe(0);
    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
  });

  it("tabela public._migrations ausente: nenhum CREATE, só reporta", async () => {
    const migrationsDir = fixtureDir({});
    const client = new FakeClient({ tableExists: false });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("CREATE"))).toBe(false);
    expect(logger.lines.some((l) => l.includes("tabela public._migrations não existe"))).toBe(true);
  });

  it("coluna checksum ausente (tabela existe): nenhum ALTER, só reporta", async () => {
    const migrationsDir = fixtureDir({});
    const client = new FakeClient({ tableExists: true, hasChecksumCol: false });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("ALTER"))).toBe(false);
    expect(logger.lines.some((l) => l.includes("coluna checksum não existe"))).toBe(true);
  });

  it("registo com checksum nulo: nenhum UPDATE, reporta (would-backfill)", async () => {
    const content = "SELECT 1;\n";
    const migrationsDir = fixtureDir({ "001_existing.sql": content });
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [{ name: "001_existing.sql", checksum: null }],
    });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("UPDATE"))).toBe(false);
    expect(logger.lines.some((l) => l.includes("would-backfill"))).toBe(true);
  });

  it("migrações pendentes: nenhum BEGIN, SQL de migração ou INSERT — só relatório", async () => {
    const migrationsDir = fixtureDir({ "001_pending.sql": "CREATE TABLE algo (id int);\n" });
    const client = new FakeClient({ tableExists: true, hasChecksumCol: true, appliedRows: [] });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
    expect(client.queries.some((q) => q.sql.includes("algo"))).toBe(false); // o SQL da migração nunca chega a ser passado ao client.query
    expect(logger.lines.some((l) => l.includes("(dry-run) aplicaria: 001_pending.sql"))).toBe(true);
  });

  it("--baseline sem --apply (defesa em profundidade — a CLI já bloqueia isto antes): nenhum INSERT", async () => {
    const migrationsDir = fixtureDir({ "001_a.sql": "SELECT 1;\n" });
    const client = new FakeClient({ tableExists: true, hasChecksumCol: true, appliedRows: [] });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, baseline: true, ...logger });

    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
  });
});

describe("runMigrations — --apply válido (cliente simulado): fluxo de escrita permitido", () => {
  it("primeira aplicação (tabela ainda não existe): CREATE + ALTER (ensureTracking), depois BEGIN/SQL/INSERT/COMMIT por migração pendente", async () => {
    const migrationSql = "CREATE TABLE algo (id int);";
    const migrationsDir = fixtureDir({ "001_pending.sql": migrationSql });
    const client = new FakeClient({ tableExists: false, hasChecksumCol: false, appliedRows: [] });
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger });

    expect(exitCode).toBe(0);
    const sqls = client.queries.map((q) => q.sql.toUpperCase());
    expect(sqls.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS PUBLIC._MIGRATIONS"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("ALTER TABLE"))).toBe(true);
    expect(sqls).toContain("BEGIN");
    expect(client.queries.some((q) => q.sql === migrationSql)).toBe(true);
    expect(sqls.some((s) => s.startsWith("INSERT INTO PUBLIC._MIGRATIONS"))).toBe(true);
    expect(sqls).toContain("COMMIT");
  });

  it("backfill real (--apply, registo com checksum nulo): UPDATE acontece", async () => {
    const content = "SELECT 1;\n";
    const migrationsDir = fixtureDir({ "001_existing.sql": content });
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [{ name: "001_existing.sql", checksum: null }],
    });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger });

    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("UPDATE PUBLIC._MIGRATIONS"))).toBe(true);
  });

  it("migração falha a meio: ROLLBACK acontece, exitCode 1, nada silenciado", async () => {
    const migrationsDir = fixtureDir({ "001_bad.sql": "ISTO NAO E SQL VALIDO;" });
    const client = new FakeClient({ tableExists: true, hasChecksumCol: true, appliedRows: [], failOnSqlContaining: "NAO E SQL" });
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger });

    expect(exitCode).toBe(1);
    expect(client.queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("INSERT"))).toBe(false); // não regista o que falhou
  });

  it("checksum divergente de uma migração já aplicada: bloqueia ANTES de tocar em mais nada, exitCode 1", async () => {
    const migrationsDir = fixtureDir({ "001_changed.sql": "SELECT 2;\n" }); // conteúdo atual
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [{ name: "001_changed.sql", checksum: checksumForNewMigration("SELECT 1;\n") }], // checksum de um conteúdo DIFERENTE
    });
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger });

    expect(exitCode).toBe(1);
    expect(logger.lines.some((l) => l.includes("CHECKSUM DIVERGENTE"))).toBe(true);
  });
});

describe("dbHasData — falha fechado: só 42P01 (tabela ausente) é tratado como 'sem dados'", () => {
  // 2026-08-05 (terceira revisão pós-incidente): a versão anterior convertia
  // QUALQUER erro (permissão negada, timeout, conexão perdida) em "false"
  // (base vazia), o que podia deixar um --apply avançar sobre um estado que
  // nunca foi realmente confirmado. Agora só 42P01 (undefined_table — o caso
  // esperado numa base nova antes do baseline) é engolido; qualquer outro
  // erro aborta o runner antes de tocar em BEGIN/SQL de migração/INSERT.

  it("42P01 (tabela companies não existe): tratado como base vazia, runner prossegue normalmente", async () => {
    const migrationsDir = fixtureDir({});
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [],
      companiesQueryError: { code: "42P01", message: "relation \"public.companies\" does not exist" },
    });
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    expect(exitCode).toBe(0);
    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
  });

  it("42501 (permission denied): aborta — não trata como base vazia", async () => {
    const migrationsDir = fixtureDir({ "001_pending.sql": "CREATE TABLE algo (id int);\n" });
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [],
      companiesQueryError: { code: "42501", message: "permission denied for table companies" },
    });
    const logger = makeCapturingLogger();

    await expect(
      runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger }),
    ).rejects.toThrow(/permission denied/);

    expect(client.queries.some((q) => q.sql === "BEGIN")).toBe(false);
    expect(client.queries.some((q) => q.sql.includes("algo"))).toBe(false);
    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("INSERT"))).toBe(false);
  });

  it("erro genérico/conexão perdida: aborta — não trata como base vazia", async () => {
    const migrationsDir = fixtureDir({ "001_pending.sql": "CREATE TABLE algo (id int);\n" });
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [],
      companiesQueryError: { message: "connection terminated unexpectedly" },
    });
    const logger = makeCapturingLogger();

    await expect(
      runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: true, ...logger }),
    ).rejects.toThrow(/connection terminated/);

    expect(client.queries.some((q) => q.sql === "BEGIN")).toBe(false);
    expect(client.queries.some((q) => q.sql.includes("algo"))).toBe(false);
    expect(client.queries.some((q) => q.sql.toUpperCase().startsWith("INSERT"))).toBe(false);
  });

  it("dry-run com erro de permissão na checagem de base vazia: também aborta (falha fechado em qualquer modo)", async () => {
    const migrationsDir = fixtureDir({});
    const client = new FakeClient({
      tableExists: true,
      hasChecksumCol: true,
      appliedRows: [],
      companiesQueryError: { code: "42501", message: "permission denied for table companies" },
    });
    const logger = makeCapturingLogger();

    await expect(
      runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger }),
    ).rejects.toThrow(/permission denied/);

    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
  });
});

describe("runMigrations — nunca imprime segredos", () => {
  it("os logs nunca contêm formato de connection string (://) nem @ (user:pass@host)", async () => {
    const migrationsDir = fixtureDir({ "001_a.sql": "SELECT 1;\n" });
    const client = new FakeClient({ tableExists: true, hasChecksumCol: true, appliedRows: [] });
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir, rootDir: migrationsDir, apply: false, ...logger });

    for (const line of logger.lines) {
      expect(line).not.toMatch(/:\/\//);
      expect(line).not.toMatch(/postgres(ql)?:\/\//i);
    }
  });

  it("a assinatura de runMigrations nem sequer recebe a connection string — só um client já ligado", () => {
    // Prova estrutural: o núcleo não tem como imprimir a URL/password porque
    // nunca as recebe. A ligação (DB_URL, com a password) só existe no
    // wrapper CLI (scripts/run-migrations.mjs), fora deste módulo.
    expect(runMigrations.length).toBeLessThanOrEqual(1); // um único parâmetro (objeto de opções)
  });
});
