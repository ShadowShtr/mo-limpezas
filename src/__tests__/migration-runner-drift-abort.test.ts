// ============================================================================
// RUNNER + DRIFT GUARD — aborta ANTES da primeira escrita
// ============================================================================
//
// O módulo de detecção tem os seus testes em `migration-drift-guard.test.ts`.
// Este ficheiro prova a única coisa que esses não podem provar: que o runner
// **para antes de executar a primeira migration**, e não a meio.
//
// É a diferença entre uma protecção e a ilusão de uma. Se a detecção corresse
// depois da primeira iteração do ciclo, a 071 já teria sido re-executada sobre
// dados reais quando o aviso aparecesse — pior do que não ter guarda nenhuma,
// porque ficaria uma base em estado intermédio e uma mensagem a dizer que
// estava protegida.
//
// Cliente falso, como em todo o resto. Nunca liga a uma base.
// ============================================================================

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../scripts/lib/migration-runner-core.mjs";
import { CODIGO_DRIFT, CODIGO_PARCIAL } from "../../scripts/lib/migration-drift-guard.mjs";

const M071 = "071_finance_periods_and_expense_categories.sql";
const M073 = "073_payment_to_cashflow.sql";

const MUTA = ["CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "DROP", "BEGIN", "COMMIT"];
const isMutating = (sql: string) => MUTA.some((p) => sql.trim().toUpperCase().startsWith(p));

/**
 * Cliente falso que responde ao catálogo — é isso que o distingue do
 * FakeClient de `migration-runner-core.test.ts`, que devolve `{ rows: [] }`
 * para queries desconhecidas (logo: schema sempre ausente, nunca drift).
 */
function fakeClient({
  ledger = [] as string[],
  tabelas = new Set<string>(),
  colunas = new Set<string>(),
  funcoes = new Set<string>(),
  companies = 1,
}) {
  const queries: { sql: string; params: unknown }[] = [];
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      const t = String(sql).trim();
      queries.push({ sql: t, params });

      if (t.startsWith("SELECT to_regclass")) {
        const alvo = String(params[0]);
        if (alvo === "public._migrations") return { rows: [{ reg: "public._migrations" }] };
        return { rows: [{ reg: tabelas.has(alvo) ? alvo : null }] };
      }
      if (t.includes("information_schema.columns")) {
        const [schema, tabela, coluna] = params as string[];
        if (tabela === "_migrations" && coluna === "checksum") return { rows: [{ ok: 1 }] };
        return { rows: colunas.has(`${schema}.${tabela}.${coluna}`) ? [{ ok: 1 }] : [] };
      }
      if (t.includes("pg_proc")) {
        const [schema, nome] = params as string[];
        return { rows: funcoes.has(`${schema}.${nome}`) ? [{ ok: 1 }] : [] };
      }
      if (t === "SELECT name, checksum FROM public._migrations") {
        return { rows: ledger.map((n) => ({ name: n, checksum: "x" })) };
      }
      if (t.startsWith("SELECT count(*)::int AS n FROM public.companies")) {
        return { rows: [{ n: companies }] };
      }
      return { rows: [] };
    },
  };
}

function logger() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, log: push, logWarn: push, logError: push };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-abort-"));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, "utf8");
  dirs.push(dir);
  return dir;
}

/** As 071/073 tal como o repo as tem: o conteúdo não importa, só o nome. */
const FICHEIROS = {
  [M071]: "-- create table expense_categories …\n",
  [M073]: "-- create function mark_payment_paid …\n",
};

/** O estado real de produção a 2026-08-17: schema presente, ledger parado na 069. */
function producao() {
  return fakeClient({
    ledger: ["069_guard_profile_tenant_role.sql"],
    tabelas: new Set(["public.expense_categories", "public.financial_periods"]),
    colunas: new Set([
      "public.cash_flow_entries.expense_category_id",
      "public.fixed_variable_payments.expense_category_id",
    ]),
    funcoes: new Set([
      "public.mark_payment_paid",
      "public.unmark_payment_paid",
      "public.is_financial_period_open",
    ]),
  });
}

describe("🔴 --apply aborta antes da primeira escrita", () => {
  it("sai com 1 e o código de drift", async () => {
    const c = producao();
    const lg = logger();
    const r = await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });

    expect(r.exitCode).toBe(1);
    expect(r.driftCode).toBe(CODIGO_DRIFT);
  });

  it("NENHUMA migration foi executada", async () => {
    const c = producao();
    const lg = logger();
    await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });

    // O SQL das migrations nunca chegou ao cliente.
    const sqlTodo = c.queries.map((q) => q.sql).join("\n");
    expect(sqlTodo).not.toContain("expense_categories …");
    expect(sqlTodo).not.toContain("mark_payment_paid …");

    // E nada foi inserido no ledger.
    expect(c.queries.some((q) => /INSERT INTO public\._migrations/i.test(q.sql))).toBe(false);
  });

  it("nenhuma transacção foi aberta — não ficou nada a meio", async () => {
    const c = producao();
    const lg = logger();
    await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });
    expect(c.queries.some((q) => q.sql.toUpperCase().startsWith("BEGIN"))).toBe(false);
    expect(c.queries.some((q) => q.sql.toUpperCase().startsWith("COMMIT"))).toBe(false);
  });

  it("a mensagem diz o que fazer, e não vaza segredos", async () => {
    const c = producao();
    const lg = logger();
    await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });
    const txt = lg.lines.join("\n");
    expect(txt).toContain(CODIGO_DRIFT);
    expect(txt).toContain("LEDGER-RECONCILIATION-PENDING");
    expect(txt).not.toMatch(/sb_secret_|sb_publishable_|eyJ|postgres:\/\//);
  });
});

describe("dry-run também reporta, sem escrever", () => {
  it("relata o estado das três e não muta nada", async () => {
    const c = producao();
    const lg = logger();
    const r = await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: false,
      ...lg,
    });

    expect(r.exitCode).toBe(1); // drift bloqueia mesmo em leitura: o estado é anómalo
    for (const { sql } of c.queries) {
      expect(isMutating(sql), `mutou: ${sql.slice(0, 60)}`).toBe(false);
    }
    const txt = lg.lines.join("\n");
    expect(txt).toMatch(/ledger: ABSENT/);
    expect(txt).toMatch(/schema: PRESENT/);
  });
});

describe("materialização parcial", () => {
  it("aborta com MIGRATION_PARTIALLY_MATERIALIZED", async () => {
    const c = fakeClient({
      ledger: ["069_guard_profile_tenant_role.sql"],
      tabelas: new Set(["public.expense_categories"]), // financial_periods falta
    });
    const lg = logger();
    const r = await runMigrations({
      client: c,
      migrationsDir: fixture({ [M071]: FICHEIROS[M071] }),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });
    expect(r.exitCode).toBe(1);
    expect(r.driftCode).toBe(CODIGO_PARCIAL);
  });
});

describe("schema genuinamente ausente → o runner segue", () => {
  it("aplica normalmente quando nada está materializado", async () => {
    const c = fakeClient({ ledger: ["069_guard_profile_tenant_role.sql"], companies: 1 });
    const lg = logger();
    const r = await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      ...lg,
    });

    expect(r.exitCode).toBe(0);
    // Aqui sim: as migrations correram e foram registadas.
    expect(c.queries.some((q) => q.sql.includes("expense_categories …"))).toBe(true);
    expect(c.queries.some((q) => /INSERT INTO public\._migrations/i.test(q.sql))).toBe(true);
  });
});

describe("--baseline avisa em vez de reconciliar em silêncio", () => {
  it("diz explicitamente que está a registar migrations já materializadas", async () => {
    const c = producao();
    const lg = logger();
    const r = await runMigrations({
      client: c,
      migrationsDir: fixture(FICHEIROS),
      rootDir: process.cwd(),
      apply: true,
      baseline: true,
      ...lg,
    });

    // Baseline continua a funcionar (tem usos legítimos)…
    expect(r.exitCode).toBe(0);
    // …mas não passa em silêncio.
    const txt = lg.lines.join("\n");
    expect(txt).toMatch(/já materializadas no schema/i);
    expect(txt).toContain("LEDGER-RECONCILIATION-PENDING");
  });
});
