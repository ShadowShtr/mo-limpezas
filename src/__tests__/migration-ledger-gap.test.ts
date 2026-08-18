// ============================================================================
// R0.1 — O LEDGER PODE TER BURACOS
// ============================================================================
// Prova, com cliente Postgres FALSO (nunca uma base real), que o runner aceita
// este estado sem o tentar "corrigir":
//
//   068 PRESENT   069 PRESENT   070 ABSENT   071 PRESENT   072 PRESENT   073 PRESENT
//
// Porque é que isto precisa de teste: o live run de 2026-08-18 provou que a 070
// não está materializada (função e trigger ausentes do catálogo), enquanto
// 071-073 estão. O R1 vai portanto reconciliar 071-073 e deixar a 070
// legitimamente pendente — um buraco deliberado na numeração. Um runner que
// assumisse sequência contínua recusaria arrancar, ou pior, trataria 071-073
// como inválidas por causa do intervalo.
//
// A propriedade que se fixa aqui: o runner decide por **membership individual**
// (`applied.has(file)` em migration-runner-core.mjs), não por maior número
// aplicado nem por continuidade. Estes testes falham se alguém introduzir
// ordenação, comparação de índices ou "preenchimento" de gaps.
//
// Ver docs/LEDGER-RECONCILIATION-R0.md, secção «Conclusão do live R0».
// ============================================================================

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { detectarDrift } from "../../scripts/lib/migration-drift-guard.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const M068 = "068_anterior.sql";
const M069 = "069_anterior.sql";
const M070 = "070_guard_profile_managed_fields.sql";
const M071 = "071_finance_periods_and_expense_categories.sql";
const M072 = "072_invoice_atomic_creation.sql";
const M073 = "073_payment_to_cashflow.sql";

const MUTATING_PREFIXES = ["CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "DROP"];
function isMutatingQuery(sql: string) {
  const s = sql.trim().toUpperCase();
  return MUTATING_PREFIXES.some((p) => s.startsWith(p));
}

interface AppliedRow {
  name: string;
  checksum: string | null;
}

/**
 * Cliente falso com catálogo controlável.
 *
 * `objectosPresentes` é o conjunto de objectos que o catálogo diz existirem —
 * é assim que se encena "071-073 materializadas, 070 não" sem base real.
 */
class FakeCatalogClient {
  queries: { sql: string; params: unknown }[] = [];

  constructor(
    private appliedRows: AppliedRow[],
    private objectosPresentes: Set<string>,
    private companiesCount = 1,
  ) {}

  async query(sql: string, params?: unknown) {
    const trimmed = String(sql).trim();
    this.queries.push({ sql: trimmed, params });
    const p = (params ?? []) as unknown[];

    if (trimmed.startsWith("SELECT to_regclass")) {
      const alvo = String(p[0]);
      if (alvo === "public._migrations") return { rows: [{ reg: "public._migrations" }] };
      return { rows: [{ reg: this.objectosPresentes.has(alvo) ? alvo : null }] };
    }
    if (trimmed.includes("information_schema.columns")) {
      // Coluna checksum de _migrations: existe sempre nestes cenários.
      if (p[1] === "_migrations") return { rows: [{ ok: 1 }] };
      const rotulo = `${p[0]}.${p[1]}.${p[2]}`;
      return { rows: this.objectosPresentes.has(rotulo) ? [{ ok: 1 }] : [] };
    }
    if (trimmed.includes("pg_proc")) {
      const rotulo = `public.${p[1]}()`;
      return { rows: this.objectosPresentes.has(rotulo) ? [{ ok: 1 }] : [] };
    }
    if (trimmed === "SELECT name, checksum FROM public._migrations") {
      return { rows: this.appliedRows.map((r) => ({ name: r.name, checksum: r.checksum })) };
    }
    if (trimmed === "SELECT name FROM public._migrations") {
      return { rows: this.appliedRows.map((r) => ({ name: r.name })) };
    }
    if (trimmed.startsWith("SELECT count(*)::int AS n FROM public.companies")) {
      return { rows: [{ n: this.companiesCount }] };
    }
    return { rows: [] };
  }
}

function makeCapturingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, log: push, logWarn: push, logError: push };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-ledger-gap-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  tempDirs.push(dir);
  return dir;
}

/** Fixture: os seis ficheiros, conteúdo irrelevante mas estável (o checksum é real). */
function fixtureSeisMigrations() {
  return fixtureDir({
    [M068]: "SELECT 68;\n",
    [M069]: "SELECT 69;\n",
    [M070]: "SELECT 70;\n",
    [M071]: "SELECT 71;\n",
    [M072]: "SELECT 72;\n",
    [M073]: "SELECT 73;\n",
  });
}

/** Ledger do estado pós-R1: tudo menos a 070, com checksums correctos. */
function ledgerComGap(dir: string): AppliedRow[] {
  return [M068, M069, M071, M072, M073].map((name) => ({
    name,
    checksum: checksumForNewMigration(fs.readFileSync(path.join(dir, name), "utf8")),
  }));
}

/** Catálogo do estado pós-R1: 071-073 materializadas, 070 ausente. */
function catalogoSemA070() {
  return new Set<string>([
    "public.expense_categories",
    "public.financial_periods",
    "public.cash_flow_entries.expense_category_id",
    "public.fixed_variable_payments.expense_category_id",
    "public.create_invoice_with_items()",
    "public.mark_payment_paid()",
    "public.unmark_payment_paid()",
    "public.is_financial_period_open()",
  ]);
}

describe("R0.1 — ledger com buraco na 070", () => {
  // ── A ────────────────────────────────────────────────────────────────────
  it("A. ledger 068,069,071,072,073 e 070 ausente: só a 070 é pendente", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: dir, apply: false, ...logger,
    });

    expect(exitCode).toBe(0);
    const linhaPendentes = logger.lines.find((l) => l.includes("migração(ões) pendente(s)"));
    expect(linhaPendentes).toContain("1 migração(ões) pendente(s)");
    expect(linhaPendentes).toContain(M070);
    for (const aplicada of [M068, M069, M071, M072, M073]) {
      expect(linhaPendentes).not.toContain(aplicada);
    }
  });

  // ── B ────────────────────────────────────────────────────────────────────
  it("B. dry-run lista a 070 e não lista 071-073", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir: dir, rootDir: dir, apply: false, ...logger });

    const aplicaria = logger.lines.filter((l) => l.includes("(dry-run) aplicaria:"));
    expect(aplicaria).toHaveLength(1);
    expect(aplicaria[0]).toContain(M070);
    for (const m of [M071, M072, M073]) {
      expect(logger.lines.some((l) => l.includes("(dry-run) aplicaria:") && l.includes(m))).toBe(false);
    }
  });

  // ── C ────────────────────────────────────────────────────────────────────
  it("C. o runner nunca tenta executar o SQL de 071-073", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir: dir, rootDir: dir, apply: false, ...logger });

    const sqlCorrido = client.queries.map((q) => q.sql).join("\n");
    expect(sqlCorrido).not.toContain("SELECT 71;");
    expect(sqlCorrido).not.toContain("SELECT 72;");
    expect(sqlCorrido).not.toContain("SELECT 73;");
    expect(client.queries.some((q) => isMutatingQuery(q.sql))).toBe(false);
  });

  // ── D ────────────────────────────────────────────────────────────────────
  it("D. nenhuma inserção automática da 070 no ledger", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());
    const logger = makeCapturingLogger();

    await runMigrations({ client, migrationsDir: dir, rootDir: dir, apply: false, ...logger });

    const escritasNoLedger = client.queries.filter(
      (q) => q.sql.toUpperCase().includes("_MIGRATIONS") && /^(INSERT|UPDATE|DELETE)/i.test(q.sql.trim()),
    );
    expect(escritasNoLedger).toHaveLength(0);
  });

  // ── E ────────────────────────────────────────────────────────────────────
  it("E. nenhum erro de sequência (SEQUENCE_GAP / OUT_OF_ORDER / MISSING_PREVIOUS)", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: dir, apply: false, ...logger,
    });

    expect(exitCode).toBe(0);
    const tudo = logger.lines.join("\n").toUpperCase();
    for (const codigo of ["SEQUENCE_GAP", "MISSING_PREVIOUS", "OUT_OF_ORDER", "NON_CONTIGUOUS"]) {
      expect(tudo).not.toContain(codigo);
    }
  });

  // ── F ────────────────────────────────────────────────────────────────────
  it("F. checksum de 071-073 continua validado individualmente apesar do gap", async () => {
    const dir = fixtureSeisMigrations();
    const ledger = ledgerComGap(dir);
    // A 072 foi alterada depois de registada — tem de bloquear na mesma.
    const corrompido = ledger.map((r) => (r.name === M072 ? { ...r, checksum: "checksum-que-nao-bate" } : r));
    const client = new FakeCatalogClient(corrompido, catalogoSemA070());
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: dir, apply: false, ...logger,
    });

    expect(exitCode).toBe(1);
    expect(logger.lines.some((l) => l.includes("CHECKSUM DIVERGENTE"))).toBe(true);
    expect(logger.lines.some((l) => l.includes(M072))).toBe(true);
  });

  // ── G ────────────────────────────────────────────────────────────────────
  it("G. drift: 070 (schema ABSENT + ledger ABSENT) não bloqueia", async () => {
    const client = new FakeCatalogClient([], catalogoSemA070());

    const drift = await detectarDrift({ client, pendentes: [M070] });

    expect(drift.deveAbortar).toBe(false);
    expect(drift.bloqueiam).toHaveLength(0);
    expect(drift.codigo).toBeNull();
  });

  it("G2. drift: 071-073 fora do ledger E presentes no schema bloqueiam (o estado pré-R1)", async () => {
    const client = new FakeCatalogClient([], catalogoSemA070());

    const drift = await detectarDrift({ client, pendentes: [M070, M071, M072, M073] });

    expect(drift.deveAbortar).toBe(true);
    expect(drift.bloqueiam.map((a: { migration: string }) => a.migration).sort()).toEqual([M071, M072, M073]);
    // A 070 aparece no relatório como UNKNOWN, mas não é ela que bloqueia.
    const a070 = drift.achados.find((a: { migration: string }) => a.migration === M070);
    expect(a070?.schema).toBe("UNKNOWN");
  });

  it("G3. drift: com 071-073 já no ledger, só a 070 é inspeccionada e nada bloqueia", async () => {
    const dir = fixtureSeisMigrations();
    const client = new FakeCatalogClient(ledgerComGap(dir), catalogoSemA070());

    // É isto que o runner passa a detectarDrift depois do R1: só os pendentes.
    const drift = await detectarDrift({ client, pendentes: [M070] });

    expect(drift.deveAbortar).toBe(false);
    expect(drift.achados).toHaveLength(1);
    expect(drift.achados[0].migration).toBe(M070);
  });

  // ── Propriedade central ──────────────────────────────────────────────────
  it("membership individual: um gap arbitrário no meio não altera a classificação", async () => {
    const dir = fixtureSeisMigrations();
    // Buraco duplo, deliberadamente fora de qualquer sequência: 069 e 071 ausentes.
    const ledger = ledgerComGap(dir).filter((r) => r.name !== M069 && r.name !== M071);
    const client = new FakeCatalogClient(ledger, new Set<string>());
    const logger = makeCapturingLogger();

    const { exitCode } = await runMigrations({
      client, migrationsDir: dir, rootDir: dir, apply: false, ...logger,
    });

    expect(exitCode).toBe(0);
    const linha = logger.lines.find((l) => l.includes("migração(ões) pendente(s)"));
    expect(linha).toContain("3 migração(ões) pendente(s)");
    for (const m of [M069, M070, M071]) expect(linha).toContain(m);
    for (const m of [M068, M072, M073]) expect(linha).not.toContain(m);
  });
});
