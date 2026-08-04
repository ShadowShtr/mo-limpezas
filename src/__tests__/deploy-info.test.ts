import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { supabaseProjectRef } from "@/lib/deploy-info";
import {
  ACTIVE_MIGRATIONS,
  EXPECTED_APPLIED_MIGRATION_COUNT,
  FROZEN_DRAFT_MIGRATIONS,
  evaluateMigrationLedger,
} from "@/lib/migration-policy";
import policy from "../../supabase/migration-policy.json";

describe("política de migrations", () => {
  it("classifica todos os SQL e mantém 064/065 congeladas", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql"));
    expect(ACTIVE_MIGRATIONS.slice().sort()).toEqual(files.sort());
    expect(FROZEN_DRAFT_MIGRATIONS).toEqual([
      "064_domain_atomicity_outbox.sql",
      "065_fix_domain_atomicity_outbox.sql",
    ]);
  });

  it("protege os hashes dos rascunhos congelados", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    for (const draft of policy.frozenDrafts) {
      const sql = fs.readFileSync(path.join(process.cwd(), draft.path), "utf8");
      const actualHash = createHash("sha256").update(sql).digest("hex");
      expect(actualHash, draft.ledgerName).toBe(draft.sha256);
      expect(fs.existsSync(path.join(dir, draft.ledgerName)), draft.ledgerName).toBe(false);
    }
  });

  it("aceita o ledger 001-063 com as quatro migrations legadas", () => {
    const names = ACTIVE_MIGRATIONS;
    expect(names).toHaveLength(EXPECTED_APPLIED_MIGRATION_COUNT);
    expect(evaluateMigrationLedger(names)).toMatchObject({ ok: true });
  });

  it("rejeita migration numerada ausente ou rascunho congelado registado", () => {
    const names = [
      ...ACTIVE_MIGRATIONS.filter((name) => name !== "063_services_full_apply_vat.sql"),
      "064_domain_atomicity_outbox.sql",
      "999_unknown.sql",
    ];
    const result = evaluateMigrationLedger(names);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("063_services_full_apply_vat.sql");
    expect(result.appliedFrozenDrafts).toContain("064_domain_atomicity_outbox.sql");
    expect(result.unexpected).toContain("999_unknown.sql");
  });
});

describe("supabaseProjectRef", () => {
  const original = process.env.NEXT_PUBLIC_SUPABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = original;
  });

  it("extrai só o subdomínio, nunca a URL completa", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijk.supabase.co";
    expect(supabaseProjectRef()).toBe("abcdefghijk");
  });

  it("devolve null sem a variável configurada", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(supabaseProjectRef()).toBeNull();
  });

  it("devolve null para uma URL que não é do Supabase", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.com";
    expect(supabaseProjectRef()).toBeNull();
  });
});
