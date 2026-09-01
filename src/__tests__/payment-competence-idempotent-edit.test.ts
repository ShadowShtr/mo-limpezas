import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/088_payment_competence_idempotent_edit.sql", "utf8");

describe("088 — competência de pagamentos", () => {
  it("só recalcula quando due_date mudou e não é NULL", () => {
    expect(migration).toMatch(/p_patch\s*\?\s*'due_date'[\s\S]*?IS NOT NULL[\s\S]*?IS DISTINCT FROM v_pag\.due_date/);
  });

  it("preserva competência quando due_date é NULL", () => {
    expect(migration).toMatch(/v_ano\s*:=\s*v_pag\.period_year[\s\S]*?v_mes\s*:=\s*v_pag\.period_month/);
    expect(migration).not.toMatch(/due_date.*IS NULL[\s\S]*?v_ano\s*:=/);
  });

  it("não modifica a migration histórica 082", () => {
    const antigo = readFileSync("supabase/migrations/082_atomic_finance_mutations.sql", "utf8");
    expect(antigo).toMatch(/IF \(p_patch \? 'due_date'\) AND \(p_patch->>'due_date'\) IS NOT NULL THEN/);
  });
});
