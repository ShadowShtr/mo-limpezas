import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeMigrationTransactionControl } from "../../scripts/lib/migration-transaction-control.mjs";

describe("inventário de controlo transacional das migrations", () => {
  it("ignora BEGIN/COMMIT em PL/pgSQL, comentários e strings", () => {
    const sql = `
      -- BEGIN; COMMIT;
      CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM 'COMMIT;';
      END;
      $fn$;
      SELECT 'BEGIN;';
    `;
    expect(analyzeMigrationTransactionControl(sql)).toMatchObject({
      controls: [],
      classification: "runner-owned",
    });
  });

  it("reconhece somente um wrapper exterior compatível", () => {
    expect(analyzeMigrationTransactionControl("/* a */ BEGIN; SELECT 1; COMMIT;\n")).toMatchObject({
      controls: [
        { command: "BEGIN", statement: 1 },
        { command: "COMMIT", statement: 3 },
      ],
      classification: "legacy-outer-wrapper",
    });
  });

  it("recusa controlos intermédios ou destrutivos", () => {
    expect(analyzeMigrationTransactionControl("SELECT 1; COMMIT; SELECT 2;").classification)
      .toBe("unsupported-control");
    expect(analyzeMigrationTransactionControl("BEGIN; SAVEPOINT s; SELECT 1; COMMIT;").classification)
      .toBe("unsupported-control");
    expect(analyzeMigrationTransactionControl("START TRANSACTION; SELECT 1; ROLLBACK;").classification)
      .toBe("unsupported-control");
  });

  it.each([
    "SELECT 'sem fim",
    "SELECT \"sem fim",
    "DO $fn$ BEGIN NULL; END",
    "/* comentário sem fim",
  ])("falha fechado quando o SQL não pode ser classificado: %s", (sql) => {
    expect(() => analyzeMigrationTransactionControl(sql)).toThrow(/termina dentro/);
  });

  it.each([
    "071_finance_periods_and_expense_categories.sql",
    "072_invoice_atomic_creation.sql",
    "073_payment_to_cashflow.sql",
    "075_cash_flow_fixed_variable_payment_reference.sql",
    "076_update_notices.sql",
  ])("classifica %s como wrapper histórico exterior", (file) => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8");
    expect(analyzeMigrationTransactionControl(sql).classification).toBe("legacy-outer-wrapper");
  });

  it("não confunde os BEGIN das funções da 106 com controlo de topo", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "106_colaborador_status_autorizacao.sql"), "utf8");
    expect(analyzeMigrationTransactionControl(sql)).toMatchObject({ controls: [], classification: "runner-owned" });
  });
});
