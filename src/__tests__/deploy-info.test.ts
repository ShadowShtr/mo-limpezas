import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CURRENT_MIGRATION_VERSION, CURRENT_MIGRATION_FILE, supabaseProjectRef } from "@/lib/deploy-info";

describe("deploy-info — CURRENT_MIGRATION_VERSION nunca fica desatualizado", () => {
  it("corresponde ao ficheiro numerado de maior número em supabase/migrations", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const maxNumber = Math.max(...files.map((f) => parseInt(f.slice(0, 3), 10)));
    const expectedVersion = String(maxNumber).padStart(3, "0");

    expect(CURRENT_MIGRATION_VERSION).toBe(expectedVersion);
    expect(files).toContain(CURRENT_MIGRATION_FILE);
    expect(CURRENT_MIGRATION_FILE.startsWith(CURRENT_MIGRATION_VERSION)).toBe(true);
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
